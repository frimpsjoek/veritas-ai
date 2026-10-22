// @ts-check
// ui-src/src/settings/sources-model.js. What the Sources chips in Settings show, as plain data: three groups ("Your
// library", "Look further", "Keeping watch"), each with its chips and a small ring, plus the "…" menu and a status
// line. Pure, so every host draws the same thing and the tests need no DOM.
//
// A chip is a switch only where the engine really obeys it:
//   papers, notes, scholarly  settings.sources.<id>   (tools.js: search_library `only`, search_scholarly `enabled`)
//   web                       settings.sources.web (on/off; Research's webSearchDefault only says which mode it runs in)
//   mcp:<name>                the server's own `enabled` (mcp-hub.js drops a disabled server's tools)
//   radar:<routine id>        the routine's status, active or paused (the scheduler skips a paused one)
// Clippings and videos, and images and PDFs, are searched with Notes (the library search only splits Zotero from
// everything else), so they are status chips that follow Notes, never switches of their own.
import { sourceSwitches } from '../../../agent/src/settings.js';

/** @typedef {"ok" | "warn" | "bad" | "off"} ChipTone */

/** What turning a chip on or off writes. `engine` is a settings patch for (await host.ai()).settings.update.
 * @typedef {{ kind: "engine", patch: Record<string, any> }
 *   | { kind: "mcp", config: import("../../../agent/src/tools").McpServerConfig & { trustUnmarked?: boolean } }
 *   | { kind: "routine", id: string, action: "pause" | "resume" }} SourceWrite */

/**
 * @typedef {{
 *   id: string,
 *   label: string,
 *   detail: string,
 *   kind: "toggle" | "status",
 *   on: boolean,
 *   tone: ChipTone,
 *   follows?: "notes",
 *   documents?: number,
 *   passages?: number,
 *   hint?: string,
 * }} SourceChip
 * `toggle` flips on/off (the web's mode, "When it helps" or "Always", is picked in Research); `status` is not a control and says why in `hint`.
 * `on` is the switch's position (for a status chip, whether the engine searches it); `tone` "bad" means on but failing; `documents`/`passages` come from /status for library chips.
 */

/**
 * @typedef {{ kind: "share", segments: { chip: string, passages: number, on: boolean }[], total: number, center: string, label: string }
 *   | { kind: "count", on: number, total: number, center: string, label: string }} SourceRing
 * `share`: the library's indexed passages, a segment per chip, lit when searched. `count`: how many chips are on.
 */

/** @typedef {{ id: "library" | "further" | "watch", label: string, ring: SourceRing | null, chips: SourceChip[], empty?: string, problem?: string }} SourceGroup
 *  `problem` is a line under the chips for something that could not be read. */

/** @typedef {"outsideServers" | "openalexKey" | "radarFeeds" | "indexStatus"} SourceMenuId */
/** @typedef {{ id: SourceMenuId, label: string, hosts: import("./settings-schema.js").SettingsHost[] }} SourceMenuItem */

/** @typedef {{ groups: SourceGroup[], menu: SourceMenuItem[], footer: string }} SourcesView */

/**
 * The parts of GET /status the chips read (http_api.py). `coverage` rows whose source starts with "_" are bookkeeping.
 * @typedef {{
 *   chunks?: number, indexed_at?: string | null, running?: boolean,
 *   indexing?: { label?: string | null } | null,
 *   coverage?: { source: string, documents: number, chunks: number }[],
 * }} IndexStatus
 */

/** /status source labels -> library chip. Anything not listed is an Obsidian note: the engine's Notes switch covers it. */
const LIBRARY_OF = /** @type {Record<string, "papers" | "clippings" | "media">} */ ({
  zotero: 'papers', Clippings: 'clippings', youtube: 'clippings', image: 'media', pdf: 'media',
});

const LIBRARY_CHIPS = /** @type {const} */ ([
  ['papers', 'Zotero papers'], ['notes', 'Obsidian notes'], ['clippings', 'Clippings and videos'], ['media', 'Images and PDFs'],
]);

export const MENU = /** @type {SourceMenuItem[]} */ ([
  { id: 'outsideServers', label: 'Outside sources and trust', hosts: ['zotero', 'obsidian', 'web'] },
  { id: 'openalexKey', label: 'OpenAlex key', hosts: ['zotero', 'obsidian', 'web'] },
  { id: 'radarFeeds', label: 'Radar feeds', hosts: ['web'] },
  { id: 'indexStatus', label: 'Search index status', hosts: ['zotero', 'obsidian', 'web'] },
]);

/** @param {number} n @param {string} one @param {string} [many] */
const count = (n, one, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** "187k", "3,289": short enough for a chip. @param {number} n */
export function shortNumber(n) {
  return n >= 10_000 ? `${Math.round(n / 1000)}k` : n.toLocaleString('en-US');
}

/** @param {IndexStatus | null} status @param {any} settings @param {boolean} pending true until /status has answered */
function libraryGroup(status, settings, pending) {
  const on = sourceSwitches(settings);
  /** @type {Record<string, { documents: number, passages: number }>} */
  const sums = { papers: { documents: 0, passages: 0 }, notes: { documents: 0, passages: 0 }, clippings: { documents: 0, passages: 0 }, media: { documents: 0, passages: 0 } };
  for (const row of status?.coverage ?? []) {
    if (String(row.source).startsWith('_')) continue;
    const sum = sums[LIBRARY_OF[row.source] ?? 'notes'];
    sum.documents += Number(row.documents) || 0;
    sum.passages += Number(row.chunks) || 0;
  }
  const reachable = Boolean(status?.coverage);
  const chips = LIBRARY_CHIPS.map(([id, label]) => {
    const searched = id === 'papers' ? on.papers : on.notes;
    const { documents, passages } = sums[id];
    const follows = id === 'clippings' || id === 'media';
    /** @type {SourceChip} */
    const chip = {
      id, label, kind: follows ? 'status' : 'toggle', on: searched, tone: searched ? 'ok' : 'off',
      detail: reachable ? count(documents, id === 'papers' ? 'paper' : id === 'notes' ? 'note' : 'item') : '',
      ...(reachable ? { documents, passages } : {}),
      ...(follows ? { follows: /** @type {const} */ ('notes'), hint: searched ? 'Searched along with your notes.' : 'Off while Obsidian notes are off.' } : {}),
    };
    if (!reachable && !pending && id !== 'papers') { chip.tone = 'warn'; chip.detail = 'Server not running'; }
    return chip;
  }).filter((c) => (reachable ? c.kind === 'toggle' || (c.documents ?? 0) > 0 : !pending || c.kind === 'toggle'));
  const total = chips.reduce((a, c) => a + (c.passages ?? 0), 0);
  const lit = chips.reduce((a, c) => a + (c.on ? c.passages ?? 0 : 0), 0);
  /** @type {SourceRing | null} */
  const ring = reachable && total > 0 ? {
    kind: 'share', total, center: `${Math.round((lit / total) * 100)}%`,
    label: `Answers draw on ${shortNumber(lit)} of ${shortNumber(total)} indexed passages`,
    segments: chips.map((c) => ({ chip: c.id, passages: c.passages ?? 0, on: c.on })),
  } : null;
  return /** @type {SourceGroup} */ ({ id: 'library', label: 'Your library', ring, chips });
}

/** @param {any} settings @param {import("../../../agent/src/tools").McpServerReport[] | null} mcp @param {boolean} pending */
function furtherGroup(settings, mcp, pending) {
  const on = sourceSwitches(settings);
  const hasKey = Boolean(settings?.openalex?.apiKey);
  const limited = settings?.openalex?.limitUntil;
  // on runs live unless Research says "When it helps", so Research off reads "Always"
  const webMode = settings?.webSearchDefault === 'cached' ? 'When it helps' : 'Always';
  /** @type {SourceChip[]} */
  const chips = [
    { id: 'scholarly', label: 'Scholarly databases', kind: 'toggle', on: on.scholarly,
      tone: !on.scholarly ? 'off' : limited ? 'bad' : hasKey ? 'ok' : 'warn',
      detail: limited ? 'OpenAlex limit reached' : hasKey ? 'OpenAlex, arXiv and more' : 'Add an OpenAlex key' },
    { id: 'web', label: 'The web', kind: 'toggle', on: on.web, tone: on.web ? 'ok' : 'off', detail: webMode },
  ];
  for (const report of mcp ?? []) {
    const usable = report.tools.filter((t) => t.verdict === 'exposed').length;
    const enabled = report.config.enabled !== false;
    chips.push({
      id: `mcp:${report.config.name}`, label: report.config.name, kind: 'toggle', on: enabled,
      tone: !enabled ? 'off' : report.state === 'connected' ? (usable ? 'ok' : 'warn') : 'bad',
      detail: !enabled ? 'Off' : report.state === 'connected' ? count(usable, 'tool') : "Couldn't connect",
      ...(enabled && report.state === 'failed' && report.error ? { hint: report.error } : {}),
    });
  }
  // A switched-on server that can't connect is not searched, so the ring doesn't count it.
  const lit = chips.filter((c) => c.on && c.tone !== 'bad').length;
  return /** @type {SourceGroup} */ ({ id: 'further', label: 'Look further', chips,
    ...(mcp === null && !pending ? { problem: "Couldn't check outside sources." } : {}),
    ring: { kind: 'count', on: lit, total: chips.length, center: `${lit}/${chips.length}`, label: `${lit} of ${chips.length} on` } });
}

/** @param {import("../../../agent/src/domain").RoutineView[] | null} routines @param {boolean} pending */
function watchGroup(routines, pending) {
  const radars = (routines ?? []).filter((r) => !('broken' in r) && r.kind === 'radar' && r.status !== 'archived');
  const chips = radars.map((r) => /** @type {SourceChip} */ ({
    id: `radar:${r.id}`, label: r.name, kind: 'toggle', on: r.status === 'active', tone: r.status === 'active' ? 'ok' : 'off',
    detail: r.status === 'active' ? count(r.radar?.sources.length ?? 0, 'feed') : 'Paused',
  }));
  const lit = chips.filter((c) => c.on).length;
  return /** @type {SourceGroup} */ ({ id: 'watch', label: 'Keeping watch', chips,
    ring: chips.length ? { kind: 'count', on: lit, total: chips.length, center: `${lit}/${chips.length}`, label: `${lit} of ${chips.length} watching` } : null,
    ...(chips.length || pending ? {} : { empty: 'Nothing watched yet.' }) });
}

/** @param {IndexStatus | null} status @param {boolean} pending */
function footerOf(status, pending) {
  if (!status) return pending ? '' : "The search index isn't reachable. Zotero papers are still searched on this computer.";
  const parts = [];
  if (status.indexed_at) parts.push(`Search index updated ${status.indexed_at}`);
  if (typeof status.chunks === 'number') parts.push(`${shortNumber(status.chunks)} passages`);
  parts.push(status.running ? (status.indexing?.label || 'Updating') : 'Up to date');
  return parts.join(' · ');
}

/**
 * The Sources chips. Every input may be null when it could not be read; the view still draws what it knows.
 * @param {IndexStatus | null} status GET /status
 * @param {any} settings (await host.ai()).settings.get()
 * @param {import("../../../agent/src/tools").McpServerReport[] | null} mcpReport (await host.ai()).mcp.list()
 * @param {(import("../../../agent/src/domain").RoutineView | import("../../../agent/src/domain").BrokenRoutine)[] | null} [routines] (await host.ai()).routines.list()
 * @param {boolean} [pending] the reads other than settings are still on their way: no counts, errors or "nothing yet" until they answer
 * @returns {SourcesView}
 */
export function sourcesModel(status, settings, mcpReport, routines = null, pending = false) {
  return {
    groups: [libraryGroup(status, settings, pending), furtherGroup(settings, mcpReport, pending), watchGroup(/** @type {any} */ (routines), pending)],
    menu: MENU,
    footer: footerOf(status, pending),
  };
}

/**
 * What a click on a chip writes, or null for a status chip (or one this function doesn't know).
 * Engine switches send only their own key (the engine merges it), so a stale copy of the other settings can't undo them.
 * @param {SourceChip} chip @param {{ settings: any, mcpReport: import("../../../agent/src/tools").McpServerReport[] | null }} ctx
 * @returns {SourceWrite | null}
 */
export function chipWrite(chip, ctx) {
  if (chip.kind === 'status') return null;
  if (chip.id === 'papers' || chip.id === 'notes' || chip.id === 'scholarly' || chip.id === 'web') {
    return { kind: 'engine', patch: { sources: { [chip.id]: !chip.on } } };
  }
  if (chip.id.startsWith('mcp:')) {
    const report = (ctx.mcpReport ?? []).find((r) => r.config.name === chip.id.slice(4));
    if (!report) return null;
    return { kind: 'mcp', config: { ...report.config, enabled: report.config.enabled === false } };
  }
  if (chip.id.startsWith('radar:')) return { kind: 'routine', id: chip.id.slice(6), action: chip.on ? 'pause' : 'resume' };
  return null;
}
