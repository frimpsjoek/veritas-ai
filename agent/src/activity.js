// @ts-check
// agent-src/src/activity.js. Spec 007 §3: compacted thinking. Pure grouping, no I/O -- used by the runtime
// (core.js, to build the `lines` stored on an assistant record) and by the UI (live, so a chat folds the same
// way while streaming as it does when reopened from its JSONL). Nothing here talks to a provider or a store.

const SEARCH_KINDS = new Set(['library', 'scholarly', 'web']);

/** A web *page* read (Claude's WebFetch, or any call whose end event named a web source) is a read, not a search. @param {{ kind: string, tool?: string, args?: Record<string, unknown>, source?: any }} call */
function isPageRead(call) {
  if (call.source?.kind === 'web') return true;
  return call.kind === 'web' && (call.tool === 'WebFetch' || (call.args?.url != null && call.args?.query == null));
}
/** @param {Call} call @returns {import("./domain").ActivityKind} */
function effectiveKind(call) { return isPageRead(call) ? 'read' : call.kind; }

/** @param {Call} call @returns {import("./domain").ActivityEntry} */
function entryFor(call) {
  return {
    id: call.id, kind: effectiveKind(call), state: !call.ended ? 'running' : call.ok === false ? 'failed' : 'done',
    label: call.startLabel,
    ...(call.detail ? { detail: call.detail } : {}), ...(call.source ? { source: call.source } : {}),
  };
}

/** @param {string} label @returns {string} the tool name a generic "Using <tool>" / mcp label was built from. */
function guessServerName(label) {
  const m = /^Using (.+)$/.exec(label ?? '');
  return m ? m[1] : 'a tool';
}

/** @param {number} n @param {string} word */
function plural(n, word) {
  const suffix = n === 1 ? '' : (/[sxz]$|[cs]h$/.test(word) ? 'es' : 's');
  return `${n} ${word}${suffix}`;
}

/**
 * One call's lifecycle inside a group: its start label/kind/tool/args, whether it ended, its end label and ok.
 * @typedef {{ id: string, kind: import("./domain").ActivityKind, tool?: string, args?: Record<string, unknown>,
 *             startLabel: string, endLabel: string | null, ok: boolean | null, ended: boolean,
 *             detail?: string, count?: number, source?: import("./domain").ActivitySource }} Call
 */

/** @param {Call} call @param {(id: string, version?: number) => { title: string, version: number } | null} [resolveResult] */
function readResultDetail(call, resolveResult) {
  const id = String(call.args?.result ?? '');
  const version = call.args?.version != null ? Number(call.args.version) : undefined;
  const resolved = resolveResult ? resolveResult(id, version) : null;
  if (resolved) return `Referenced “${resolved.title}” V${resolved.version}`;
  return call.endLabel ?? call.startLabel; // falls back to the provider's own "Referenced result R2" label
}

/** Builds the finished (or currently running) ActivityLine for one group of calls + buffered reasoning.
 * @param {{ id: string, calls: Call[], reasoning: string[] }} group
 * @param {(id: string, version?: number) => { title: string, version: number } | null} [resolveResult] */
function lineForGroup(group, resolveResult) {
  const { calls } = group;
  const running = calls.filter((c) => !c.ended);
  const failed = calls.filter((c) => c.ended && c.ok === false).length;
  const reasoning = group.reasoning.length ? group.reasoning.join('') : null;
  const items = calls.map((c) => c.endLabel ?? c.startLabel);
  const entries = calls.map(entryFor);

  if (running.length) {
    // spec 007 §3.2 rule 3: while running, the detail is the current label, one line only. Title is left as the
    // eventual computed one so the icon/grouping doesn't flicker between running and done.
    const last = running[running.length - 1];
    const { title, icon } = classify(calls, resolveResult);
    return { id: group.id, icon, title, detail: last.startLabel, state: /** @type {const} */ ('running'), items, entries, reasoning };
  }

  if (!calls.length) {
    // Nothing but reasoning.
    return { id: group.id, icon: /** @type {const} */ ('thinking'), title: 'Thought it through', detail: null, state: /** @type {const} */ ('done'), items, entries, reasoning };
  }

  const { title, icon, detail } = classify(calls, resolveResult);
  const failNote = failed ? `${failed} failed` : null; // a past participle: no plural ending
  const combined = [detail, failNote].filter(Boolean).join(' · ') || null;
  return { id: group.id, icon, title, detail: combined, state: /** @type {const} */ ('done'), items, entries, reasoning };
}

/** The done-state title/icon/detail for a finished group of calls (spec 007 §3.2 rule 2).
 * @param {Call[]} calls @param {(id: string, version?: number) => { title: string, version: number } | null} [resolveResult]
 * @returns {{ title: string, icon: import("./domain").ActivityLine["icon"], detail: string | null }} */
function classify(calls, resolveResult) {
  const searches = calls.filter((c) => SEARCH_KINDS.has(c.kind) && !isPageRead(c));
  const reads = calls.filter((c) => c.kind === 'read' || isPageRead(c));
  const pages = reads.filter(isPageRead).length;
  const sources = reads.length - pages;
  // "read 3 sources" for papers and notes, "read 23 pages" for web pages; both when a turn read both.
  const readWords = (/** @type {string} */ paperWord) => [sources ? plural(sources, paperWord) : '', pages ? plural(pages, 'page') : ''].filter(Boolean).join(' · read ');
  const results = calls.filter((c) => c.kind === 'result');
  const mcp = calls.filter((c) => c.kind === 'mcp');

  if (searches.length) {
    const icon = searches.some((c) => c.kind === 'web') && searches.every((c) => c.kind !== 'library') ? 'web'
      : searches.some((c) => c.kind === 'scholarly') && searches.every((c) => c.kind !== 'library') ? 'scholarly' : 'library';
    let detail = `Conducted ${plural(searches.length, 'search')}`;
    if (reads.length) detail += ` · read ${readWords('source')}`;
    return { title: 'Ran analysis', icon, detail };
  }
  if (reads.length) {
    return { title: 'Read sources', icon: 'read', detail: [sources ? plural(sources, 'paper') : '', pages ? plural(pages, 'page') : ''].filter(Boolean).join(' · ') };
  }
  if (results.length) {
    return { title: 'Read context', icon: 'result', detail: results.map((c) => readResultDetail(c, resolveResult)).join(', ') };
  }
  if (mcp.length) {
    const server = guessServerName(mcp[0].endLabel ?? mcp[0].startLabel);
    return { title: `Used ${server}`, icon: 'mcp', detail: null };
  }
  return { title: 'Used a tool', icon: 'mcp', detail: null };
}

/**
 * Groups a turn's raw events into ActivityLine[] (spec 007 §3.2). Consecutive `activity`/`reasoning` events with
 * no `text` delta between them form one group; the reasoning buffered just before a group belongs to it. A
 * `line` event (an engine-authored step line, §3.3) passes through unchanged, flushing whatever group came
 * before it. `text`, `done` and `failed` each flush the current group.
 * @param {Iterable<import("./domain").AgentEvent<any>>} events
 * @param {{ resolveResult?: (id: string, version?: number) => { title: string, version: number } | null }} [ctx]
 * @returns {import("./domain").ActivityLine[]}
 */
export function compactActivities(events, ctx = {}) {
  /** @type {import("./domain").ActivityLine[]} */
  const lines = [];
  /** @type {Map<string, Call>} */
  let calls = new Map();
  /** @type {string[]} */
  let reasoning = [];
  let n = 0;

  function flush() {
    if (!calls.size && !reasoning.length) return;
    n += 1;
    lines.push(lineForGroup({ id: `line-${n}`, calls: [...calls.values()], reasoning }, ctx.resolveResult));
    calls = new Map();
    reasoning = [];
  }

  for (const ev of events) {
    if (ev.type === 'activity') {
      let call = calls.get(ev.id);
      if (!call) {
        call = { id: ev.id, kind: ev.kind, tool: ev.tool, args: ev.args, startLabel: ev.label, endLabel: null, ok: null, ended: false };
        calls.set(ev.id, call);
      }
      if (ev.phase === 'start') {
        call.startLabel = ev.label;
        call.kind = ev.kind;
        if (ev.tool) call.tool = ev.tool;
        if (ev.args) call.args = ev.args;
      } else {
        call.endLabel = ev.label;
        call.ok = ev.ok ?? true;
        call.ended = true;
        if (ev.args) call.args = ev.args;
        if (ev.detail) call.detail = ev.detail;
        if (ev.count != null) call.count = ev.count;
        if (ev.source) call.source = ev.source;
        if (ev.tool) call.tool = ev.tool;
      }
    } else if (ev.type === 'reasoning') {
      if (ev.delta) reasoning.push(ev.delta);
    } else if (ev.type === 'line') {
      flush();
      lines.push(ev.line);
    } else if (ev.type === 'text') {
      if (ev.delta) flush();
    } else if (ev.type === 'done' || ev.type === 'failed') {
      flush();
    }
  }
  flush();
  return lines;
}

/** The kind an old record's plain label most likely came from, so a legacy row still gets a fitting icon. @param {string} label @returns {import("./domain").ActivityKind} */
function kindFromLabel(label) {
  if (/^Search(ing|ed) the web/.test(label)) return 'web';
  if (/^Search(ing|ed) the literature/.test(label)) return 'scholarly';
  if (/^Search|^Finding|^Found/.test(label)) return 'library';
  if (/^Referenced/.test(label)) return 'result';
  if (/^Read|^Reading/.test(label)) return 'read';
  return 'mcp';
}

/** Entries for a line that only has labels (an old record, or a hand-made line): no detail, no source.
 *  @param {string[]} labels @param {string} [prefix] @returns {import("./domain").ActivityEntry[]} */
export function entriesFromLabels(labels, prefix = 'legacy') {
  return (labels ?? []).map((label, i) => ({ id: `${prefix}-${i + 1}`, kind: kindFromLabel(label), state: /** @type {const} */ ('done'), label }));
}

/** A label in the past tense, for a step that has finished: "Searching your papers for "x"" -> "Searched your papers
 *  for "x"". Labels that are already past tense, or not one of ours, come back as they are.
 *  @param {string} label */
export function pastTense(label) {
  return String(label ?? '')
    .replace(/^Searching /, 'Searched ').replace(/^Reading /, 'Read ').replace(/^Finding /, 'Found ')
    .replace(/^Using /, 'Used ').replace(/^Referencing /, 'Referenced ');
}

/** spec 007 §3.1: an old assistant record has only `activities: string[]` (no `lines`). It folds into one line,
 *  "Used N tools", so a reopened old chat still shows something instead of the pre-E2 per-tool rows.
 *  @param {string[]} activities @returns {import("./domain").ActivityLine[]} */
export function linesFromLabels(activities) {
  if (!activities?.length) return [];
  return [{
    id: 'legacy', icon: 'thinking', title: `Used ${plural(activities.length, 'tool')}`, detail: null,
    state: 'done', items: activities.slice(), reasoning: null, entries: entriesFromLabels(activities),
  }];
}
