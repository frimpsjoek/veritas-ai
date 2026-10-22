// @ts-check
// ui-src/src/chat/usage-line.js. The one quiet line under the depth slider: how much of the chosen AI's own usage
// window the latest turn reported ("Codex: 42% of 5-hour window · 3 minutes ago"). Empty when nothing is known.
import { nameOf } from './provider-switch.js';
import { ago } from './steps-data.js';

/** @param {number} minutes */
function windowName(minutes) {
  if (!(minutes > 0)) return 'usage window';
  return minutes % 60 === 0 ? `${minutes / 60}-hour window` : `${Math.round(minutes)}-minute window`;
}

/**
 * @param {{ provider: string, usage?: { kind: string, percentUsed?: number, windowMinutes?: number, at?: string } | null }[] | null | undefined} statuses
 * @param {string | undefined} provider the AI the report will use
 * @param {number} [now]
 * @returns {string} '' when the provider has reported no window reading
 */
export function usageLine(statuses, provider, now = Date.now()) {
  const usage = (statuses ?? []).find((s) => s.provider === provider)?.usage;
  if (!provider || !usage || usage.kind !== 'rate_limit' || !Number.isFinite(usage.percentUsed)) return '';
  const used = `${nameOf(provider)}: ${Math.round(/** @type {number} */ (usage.percentUsed))}% of ${windowName(usage.windowMinutes ?? 0)}`;
  const age = usage.at ? ago(usage.at, now) : '';
  return age ? `${used} · ${age}` : used;
}
