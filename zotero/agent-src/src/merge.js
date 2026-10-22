// @ts-check
// agent-src/src/merge.js. Live activity (spec 007): the tool host reports its own tool calls the moment they
// happen; a provider reports them late and in bursts (Codex batches a script's nested calls). These two helpers
// merge the host's events into the provider's stream without waiting on it, and drop the provider's duplicates.

/**
 * Yields the provider's events and the host's events as they arrive, whichever comes first. Order within each
 * source is kept. Ends when the provider stream ends (host events already queued are flushed first) or, after
 * `signal` aborts, when the provider has not unwound within `graceMs` (a provider normally ends at once on abort,
 * often with its own "cancelled" event, which is still delivered).
 * @param {AsyncIterable<any>} providerStream
 * @param {(push: (ev: any) => void) => () => void} subscribe  registers the host listener, returns its unsubscribe
 * @param {AbortSignal} signal
 * @param {number} [graceMs]
 * @returns {AsyncGenerator<{ host: boolean, ev: any }>}
 */
export async function* mergeHostEvents(providerStream, subscribe, signal, graceMs = 2000) {
  /** @type {any[]} */
  const queue = [];
  /** @type {(() => void) | null} */
  let wake = null;
  const unsubscribe = subscribe((ev) => { queue.push(ev); wake?.(); });
  const it = providerStream[Symbol.asyncIterator]();
  /** @type {Promise<{ r?: IteratorResult<any>, e?: unknown }> | null} */
  let pending = null;
  let done = false;
  let graceUp = false;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let graceTimer = null;
  const onAbort = () => { graceTimer = setTimeout(() => { graceUp = true; wake?.(); }, graceMs); };
  if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      while (queue.length) yield { host: true, ev: queue.shift() };
      if (done || graceUp) break;
      pending ??= it.next().then((r) => ({ r }), (e) => ({ e }));
      // No await sits between the drain above and this promise, so a host event cannot slip in unseen.
      const woken = new Promise((resolve) => { wake = () => resolve(undefined); });
      const got = await Promise.race([pending, woken]);
      wake = null;
      if (!got) continue;
      pending = null;
      if (got.e !== undefined) throw got.e;
      if (got.r?.done) { done = true; continue; }
      yield { host: false, ev: got.r?.value };
    }
  } finally {
    unsubscribe();
    signal.removeEventListener('abort', onAbort);
    if (graceTimer) clearTimeout(graceTimer);
    // A stuck `next()` cannot be joined (return() would queue behind it), so it is abandoned, not awaited.
    if (!done) { const closing = it.return?.(); if (!pending) await closing; else closing?.catch(() => {}); }
  }
}

/** The key a provider's own lib-tool activity is held under while we wait to see whether the host reports it. The
 *  Codex "Running a tool script" wrapper has no tool name; it is held under SCRIPT and dropped once the host reports
 *  anything, since the host's rows are what that script did. */
const SCRIPT = '*script';

/**
 * Dedupe: our own library tools (`isHostTool`: search_library, read_source, ... bare or `mcp__lib__`-prefixed) are
 * reported by the host, so a provider's activity event for one is dropped. Everything else (web search, WebFetch,
 * third-party MCP servers, commands, reasoning, text) passes through untouched.
 *
 * Fallback: a provider event for a lib tool is held until either the host reports that tool (then dropped) or the
 * provider says something else / ends (then released, in order), so a runtime whose host reports nothing (a scripted
 * provider, a session without `onActivity`) still shows the provider's rows. With `hostReports` false nothing is held.
 * @param {AsyncIterable<{ host: boolean, ev: any }>} merged
 * @param {{ isHostTool: (name: string) => boolean, hostReports: boolean }} opts
 * @returns {AsyncGenerator<{ host: boolean, ev: any }>}
 */
export async function* dedupeHostTools(merged, opts) {
  const bare = (/** @type {unknown} */ n) => String(n ?? '').replace(/^mcp__lib__/, '');
  /** @type {{ host: boolean, ev: any }[]} */
  let held = [];
  /** Tool names the host has reported this turn. @type {Set<string>} */
  const reported = new Set();
  let anyReported = false;
  const keyOf = (/** @type {any} */ ev) => (ev.tool ? bare(ev.tool) : SCRIPT);
  const heldKind = (/** @type {any} */ ev) => ev.type === 'activity' && (ev.tool ? opts.isHostTool(ev.tool) : ev.label === 'Running a tool script');

  for await (const item of merged) {
    const { host, ev } = item;
    if (host) {
      if (ev.type === 'activity' && ev.tool) {
        reported.add(bare(ev.tool));
        anyReported = true;
        held = held.filter((h) => keyOf(h.ev) !== bare(ev.tool) && keyOf(h.ev) !== SCRIPT);
      }
      yield item;
      continue;
    }
    if (opts.hostReports && heldKind(ev)) {
      if (ev.tool ? reported.has(bare(ev.tool)) : anyReported) continue; // the host already reported it
      held.push(item);
      continue;
    }
    // Any other provider event proves the held calls were not host-reported in time; release them first.
    const release = held; held = [];
    for (const h of release) yield h;
    yield item;
  }
  for (const h of held) yield h;
}
