// @ts-check
// agent-src/src/eventlog.js. Per-conversation sequence numbers for the live turn, so a client that drops the
// connection (a phone waking up, a desktop reload) can resume with `after=seq` instead of missing events. Only
// one turn per conversation may be in flight, so `send` while a turn runs is refused (service.d.ts, `send`).

const RETAIN_MS = 5 * 60 * 1000;

export function eventLog() {
  const logs = new Map(); // conversationId -> { seq, events, listeners, inFlight, expiresAt }

  function ensure(id) {
    let log = logs.get(id);
    if (!log) { log = { seq: 0, events: [], listeners: new Set(), inFlight: false, expiresAt: Infinity }; logs.set(id, log); }
    return log;
  }

  function sweep() {
    const now = Date.now();
    for (const [id, log] of logs) if (!log.inFlight && log.expiresAt <= now) logs.delete(id);
  }

  return {
    isInFlight(id) { return logs.get(id)?.inFlight ?? false; },

    /** The last sequence number handed out for `id` (0 before any event). */
    lastSeq(id) { return logs.get(id)?.seq ?? 0; },

    /** Marks a turn as running. Throws if one is already in flight (service.d.ts's one-turn-per-conversation rule). */
    begin(id) {
      const log = ensure(id);
      if (log.inFlight) throw new Error(`a turn is already running for conversation ${id}`);
      log.inFlight = true;
      log.events = []; // the previous turn's events (kept for a late reader) must not replay under this one; seq keeps counting
      log.expiresAt = Infinity;
      return log.seq;
    },

    end(id) {
      const log = ensure(id);
      log.inFlight = false;
      log.expiresAt = Date.now() + RETAIN_MS;
      // A subscriber blocked in the wait loop below only re-checks `inFlight` when a listener fires; without
      // this, a long-poll that caught up exactly as the turn finished would wait out its whole timeout for an
      // event that will never come.
      for (const listener of log.listeners) listener(null);
      sweep();
    },

    /** @returns {{ seq: number, [k: string]: any }} the sequenced event */
    push(id, event) {
      const log = ensure(id);
      log.seq += 1;
      const sequenced = { ...event, seq: log.seq };
      log.events.push(sequenced);
      for (const listener of log.listeners) listener(sequenced);
      return sequenced;
    },

    /** Replays events after `after`, then (if a turn is still running) waits for new ones until it ends. */
    async *subscribe(id, after = 0, signal) {
      const log = ensure(id);
      for (const ev of log.events) if (ev.seq > after) yield ev;
      if (!log.inFlight) return;

      const queue = [];
      let wake = null;
      const listener = (ev) => {
        if (ev === null) { wake?.(); wake = null; return; } // end() calling in: nothing new, just re-check inFlight
        if (ev.seq > after) { queue.push(ev); wake?.(); wake = null; }
      };
      log.listeners.add(listener);
      // An aborted watcher (agentd's long-poll giving up its wait) wakes the loop below so it can return; without
      // this it would sit on `wake` until the next event, and swallow that event when it arrived.
      const onAbort = () => { wake?.(); wake = null; };
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        while (log.inFlight || queue.length) {
          if (signal?.aborted) return;
          if (queue.length) { yield queue.shift(); continue; }
          await new Promise((resolve) => { wake = resolve; });
        }
      } finally {
        log.listeners.delete(listener);
        signal?.removeEventListener('abort', onAbort);
      }
    },
  };
}
