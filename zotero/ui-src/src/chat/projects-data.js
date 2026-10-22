// @ts-check
// ui-src/src/chat/projects-data.js. The pure side of Projects (spec 011 U5): which project a history entry is in,
// the filtered list, the switcher's words, and the rows of the two menus. No DOM; projects-menu.js draws them.
// A project is a label: an id with no project behind it (deleted, or from a newer server) means "no project".

export const ALL_CHATS = 'All chats';

/** @typedef {{ id: string, name: string }} ProjectLike */
/** @typedef {{ kind: string, conversation?: { project?: string | null }, progress?: { project?: string | null } }} HistoryEntry */

/** The project id a chat summary or report progress is in, or null (none, removed, or an id that no longer exists).
 *  @param {{ project?: string | null } | null | undefined} summary @param {Iterable<string>} knownIds */
export function projectOf(summary, knownIds) {
  const id = summary?.project;
  if (!id) return null;
  return new Set(knownIds).has(id) ? id : null;
}

/** @param {HistoryEntry} entry */
function memberOf(entry) {
  if (entry.kind === 'chat') return entry.conversation?.project ?? null;
  if (entry.kind === 'report') return entry.progress?.project ?? null;
  return null; // a saved search without a session joins a project only once it is opened (D5)
}

/** The history entries of the open project; everything when none is open.
 *  @template {HistoryEntry} T @param {T[]} entries @param {string | null | undefined} projectId @param {Iterable<string>} knownIds @returns {T[]} */
export function filterEntries(entries, projectId, knownIds) {
  if (!projectId || !new Set(knownIds).has(projectId)) return entries;
  return entries.filter((entry) => memberOf(entry) === projectId);
}

/** What the switcher reads. @param {ProjectLike | null | undefined} project */
export function switcherLabel(project) {
  return project?.name || ALL_CHATS;
}

/** The line under an empty project. @param {ProjectLike | null | undefined} project */
export function emptyLine(project) {
  if (!project) return 'Your chats and reports appear here.';
  return `Nothing in ${project.name} yet. Start a chat, or move one here from its ... menu.`;
}

/** The warning before a project is deleted. @param {ProjectLike} project */
export function deleteLine(project) {
  return `Delete "${project.name}"? Its chats and reports stay in your history.`;
}

/**
 * Rows of the switcher popover. `action` is what the row does; a `selected` row carries the check mark.
 * @param {ProjectLike[]} projects @param {string | null | undefined} openId
 * @returns {{ type: 'item' | 'separator', label?: string, action?: 'all' | 'open' | 'new' | 'rename' | 'delete', id?: string, selected?: boolean }[]}
 */
export function projectMenu(projects, openId) {
  const open = projects.some((p) => p.id === openId) ? openId : null;
  const rows = /** @type {ReturnType<typeof projectMenu>} */ ([{ type: 'item', label: ALL_CHATS, action: 'all', selected: !open }]);
  for (const p of projects) rows.push({ type: 'item', label: p.name, action: 'open', id: p.id, selected: p.id === open });
  rows.push({ type: 'separator' }, { type: 'item', label: 'New project...', action: 'new' });
  if (open) rows.push({ type: 'item', label: 'Rename project...', action: 'rename' }, { type: 'item', label: 'Delete project...', action: 'delete' });
  return rows;
}

/**
 * Rows of a history row's menu. A chat can be renamed here; a report cannot. "Move to project" lists the projects
 * (the current one checked) and "New project..."; "Remove from project" shows only for a member.
 * @param {HistoryEntry} entry @param {ProjectLike[]} projects @param {boolean} [canProject] false on an older server (no project rows)
 * @returns {{ type: 'item' | 'heading' | 'separator', label?: string, action?: 'rename' | 'move' | 'new' | 'remove-from' | 'delete', id?: string, selected?: boolean }[]}
 */
export function rowMenu(entry, projects, canProject = true) {
  const rows = /** @type {ReturnType<typeof rowMenu>} */ ([]);
  if (entry.kind === 'chat') rows.push({ type: 'item', label: 'Rename', action: 'rename' });
  const current = projectOf(entry.kind === 'chat' ? entry.conversation : entry.progress, projects.map((p) => p.id));
  const movable = canProject && (entry.kind === 'chat' || entry.kind === 'report');
  if (movable) {
    rows.push({ type: 'heading', label: 'Move to project' });
    for (const p of projects) rows.push({ type: 'item', label: p.name, action: 'move', id: p.id, selected: p.id === current });
    rows.push({ type: 'item', label: 'New project...', action: 'new' });
    if (current) rows.push({ type: 'item', label: 'Remove from project', action: 'remove-from' });
  }
  if (entry.kind !== 'report') {
    if (rows.length) rows.push({ type: 'separator' });
    rows.push({ type: 'item', label: 'Delete', action: 'delete' });
  }
  return rows;
}
