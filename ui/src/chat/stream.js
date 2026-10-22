// @ts-check
// ui-src/src/chat/stream.js. Pure helpers for a streaming answer (spec 008 S5, A3): what part of the raw text
// the user may see, and how long a turn has run.

const OPEN = '<think>';
const CLOSE = '</think>';
const TABLE_FENCE = /(^|\n)[ \t]*(`{3,}|~{3,})[ \t]*sb-table[^\n]*(\n|$)/;
const TABLE_FENCE_START = '```sb-table';

/**
 * The part of a streamed answer that may show: every closed <think>…</think> block removed, everything from an
 * unclosed <think> on cut off, and a half-received "<thi" at the very end held back until the next delta says
 * whether it is a tag. Local models write their reasoning inline this way. The chat's table block (spec 007 §1.6,
 * a fenced `sb-table` block of JSON the engine turns into a table artifact) never shows either: a finished block is
 * cut out, an unfinished one cuts the text off at its fence, and a half-received fence ("```sb-t") is held back.
 * @param {string} raw
 */
export function visibleText(/** @type {string} */ raw) {
  return hideTableBlock(hideThinking(raw));
}

/** Whether the answer so far contains an `sb-table` fence, so the chat can say "Making a table…" instead.
 *  @param {string} raw */
export function hasTableBlock(raw) {
  const text = hideThinking(raw);
  return TABLE_FENCE.test(text);
}

/** How many characters at the very end could be the start of an `sb-table` fence (0 when none). @param {string} text */
function heldBackFence(text) {
  const line = text.slice(text.lastIndexOf('\n') + 1).replace(/^[ \t]+/, '');
  return line.length > 3 && line.length < TABLE_FENCE_START.length && TABLE_FENCE_START.startsWith(line)
    ? text.length - text.lastIndexOf('\n') - 1 : 0;
}

/** @param {string} text */
function hideTableBlock(text) {
  let out = '';
  let rest = text;
  for (;;) {
    const open = TABLE_FENCE.exec(rest);
    if (!open) break;
    out += rest.slice(0, open.index) + open[1];
    const fence = open[2];
    const after = rest.slice(open.index + open[0].length);
    const close = new RegExp(`(^|\\n)[ \\t]*${fence[0]}{${fence.length},}[ \\t]*(\\n|$)`).exec(after);
    if (!close) return out.replace(/\n$/, '');
    rest = after.slice(close.index + close[0].length);
  }
  out += rest;
  const held = heldBackFence(out);
  return held ? out.slice(0, out.length - held) : out;
}

/** @param {string} raw */
function hideThinking(raw) {
  let out = '';
  let at = 0;
  for (;;) {
    const open = raw.indexOf(OPEN, at);
    if (open === -1) { out += raw.slice(at); break; }
    out += raw.slice(at, open);
    const close = raw.indexOf(CLOSE, open + OPEN.length);
    if (close === -1) return out;
    at = close + CLOSE.length;
  }
  for (let k = Math.min(OPEN.length - 1, out.length); k > 0; k--) {
    if (OPEN.startsWith(out.slice(-k))) return out.slice(0, -k);
  }
  return out;
}

/** "7s", "2m 5s", "1h 0m 12s". @param {number} ms */
export function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h ${m}m ${s}s`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}
