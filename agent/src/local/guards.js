// @ts-check
// agent-src/src/local/guards.js (spec 010 §4). A small model that loops repeats a line or a sentence until the token
// limit. This watches the streamed text and trips when one unit of 12+ characters has finished three times.

/**
 * @param {{ minChars?: number, times?: number }} [opts]
 * @returns {{ push(delta: string): boolean, text(): string, stopped(): boolean }}
 *   `push` returns true once the stream should be stopped; `text()` is everything so far, cut back to just
 *   after the first copy of the repeated unit once stopped.
 */
export function createRepeatGuard({ minChars = 12, times = 3 } = {}) {
  let full = '';
  let pos = 0; // start of the unit being read
  let tripped = null; // { keepUntil }
  /** @type {Map<string, { count: number, end: number }>} */
  const seen = new Map();

  return {
    push(delta) {
      if (tripped) return true;
      full += delta;
      for (;;) {
        const rest = full.slice(pos);
        const m = /\n|[.!?](?=\s)/.exec(rest);
        if (!m) return false;
        const end = pos + m.index + (m[0] === '\n' ? 0 : 1);
        const unit = full.slice(pos, end).trim().replace(/\s+/g, ' ');
        pos = pos + m.index + 1;
        if (unit.length < minChars) continue;
        const entry = seen.get(unit);
        if (!entry) { seen.set(unit, { count: 1, end }); continue; }
        entry.count += 1;
        if (entry.count >= times) { tripped = { keepUntil: entry.end }; return true; }
      }
    },
    text: () => (tripped ? full.slice(0, tripped.keepUntil).trimEnd() : full),
    stopped: () => tripped !== null,
  };
}
