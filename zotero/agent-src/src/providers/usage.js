// @ts-check
// agent-src/src/providers/usage.js. The rate-limit notice both CLI providers emit, with the numbers kept as a
// structured `usage` next to the human text (spec 011 U4 section 4): core.js remembers the latest per provider so
// a routine can tell whether the window is already half used, and the report can show one quiet line.

/** A reset time as an ISO string. Codex sends epoch seconds, Claude may send seconds, milliseconds or an ISO text.
 *  @param {unknown} value @returns {string | undefined} */
export function resetIso(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return new Date(value < 1e11 ? value * 1000 : value).toISOString();
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return undefined;
}

/**
 * @param {{ text: string, percentUsed: number, windowMinutes: number, resetsAt?: unknown }} a
 * @returns {import("../provider").ProviderEvent}
 */
export function rateLimitNotice({ text, percentUsed, windowMinutes, resetsAt }) {
  const reset = resetIso(resetsAt);
  return { type: 'notice', kind: 'rate_limit', text, usage: { percentUsed, windowMinutes, ...(reset ? { resetsAt: reset } : {}) } };
}
