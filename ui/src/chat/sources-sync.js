// @ts-check
// ui-src/src/chat/sources-sync.js. The chat's four source pills and the Sources chips in Settings are one state: the
// engine's settings.sources (papers, notes, scholarly, web). `webSearchDefault` (Research) is never written from here;
// it only says which mode the web runs in once it is on. Pure helpers, so chat.js only wires them in. The old per-app
// `chatSources` pref stays as the offline fallback and as the one-time migration source.
import { sourceSwitches } from '../../../agent/src/settings.js';

/** @typedef {{ papers: boolean, notes: boolean, scholarly: boolean, web: boolean }} Pills */

/** The pills the engine's saved settings describe. @param {any} settings @returns {Pills} */
export function pillsFrom(settings) {
  return sourceSwitches(settings);
}

/** The pref as the pills it meant, reading the pre-005 `{ library }` shape too. @param {any} pref */
function prefPills(pref) {
  if (!pref || typeof pref !== 'object') return null;
  if ('papers' in pref || 'notes' in pref) return { papers: pref.papers !== false, notes: pref.notes !== false, scholarly: pref.scholarly !== false, web: Boolean(pref.web) };
  if ('library' in pref) return { papers: pref.library !== false, notes: pref.library !== false, scholarly: pref.scholarly !== false, web: Boolean(pref.web) };
  return null;
}

/**
 * Once per app: what a saved `chatSources` pref moves into the engine, or null when there is nothing to move. Only
 * switches whose pref value differs from what the engine holds (or defaults to) are written, so an app that agrees
 * with the engine adds nothing. `webSearchDefault` is never part of it.
 * @param {any} pref @param {any} settings @returns {Record<string, any> | null}
 */
export function migrationPatch(pref, settings) {
  const saved = prefPills(pref);
  if (!saved) return null;
  const now = sourceSwitches(settings);
  /** @type {Record<string, boolean>} */
  const sources = {};
  for (const key of /** @type {const} */ (['papers', 'notes', 'scholarly', 'web'])) {
    if (saved[key] !== now[key]) sources[key] = saved[key];
  }
  return Object.keys(sources).length ? { sources } : null;
}

/** What flipping one pill writes: its own key only, which the engine merges, so a settings copy that went stale
 *  (Settings changed another switch meanwhile) can't undo that change. @param {keyof Pills} id @param {Pills} pills */
export function togglePatch(id, pills) {
  return { sources: { [id]: !pills[id] } };
}

/** The `web` value a send carries: off, or the mode Research picked ("When it helps" is cached, anything else, including
 *  Research off, is live). @param {Pills} pills @param {any} settings @returns {"off" | "cached" | "live"} */
export function webFor(pills, settings) {
  if (!pills.web) return 'off';
  return settings?.webSearchDefault === 'cached' ? 'cached' : 'live';
}
