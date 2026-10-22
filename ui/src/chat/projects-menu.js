// @ts-check
// ui-src/src/chat/projects-menu.js. The Projects DOM (spec 011 U5): the quiet switcher row at the top of the history,
// its popover, and the menu behind a history row's "..." (or right-click). New project and Rename are an inline
// text field in the popover and Delete project an inline confirm: no dialog boxes. The view supplies state and
// actions (see the `ProjectsView` shape below); the rows come from projects-data.js.
import { h } from '../dom.js';
import { icon } from '../icons.js';
import { openPopover, menuItem } from './popover.js';
import { projectMenu, rowMenu, switcherLabel, deleteLine } from './projects-data.js';

/**
 * @typedef {object} ProjectsView
 * @property {Document} doc
 * @property {HTMLElement} side the history column (the popovers sit in it)
 * @property {{ id: string, name: string }[]} projects
 * @property {string | null} projectId the open project, or null for All chats
 * @property {(id: string | null) => void} openProject
 * @property {(name: string) => Promise<{ id: string, name: string }>} createProject
 * @property {(id: string, name: string) => Promise<void>} renameProject
 * @property {(id: string) => Promise<void>} removeProject
 * @property {(entry: any, projectId: string | null) => Promise<void>} moveEntry
 * @property {(entry: any) => void} renameEntry
 * @property {(entry: any) => void} deleteEntry
 */

/** The switcher: one quiet button, "All chats" or the open project's name, with a chevron. Click opens the menu.
 *  @param {ProjectsView} view */
export function buildSwitcher(view) {
  const doc = view.doc;
  const btn = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sb-ai-project'));
  btn.setAttribute('type', 'button');
  btn.setAttribute('aria-haspopup', 'menu');
  btn.addEventListener('click', () => openSwitcherMenu(view, btn));
  paintSwitcher(view, btn);
  return btn;
}

/** @param {ProjectsView} view @param {HTMLElement} btn */
export function paintSwitcher(view, btn) {
  const open = view.projects.find((p) => p.id === view.projectId) ?? null;
  const label = h(view.doc, 'span', 'sb-ai-project-label', switcherLabel(open));
  btn.replaceChildren(label, icon(view.doc, 'chevron', 'sb-ai-icon sb-ai-project-chevron'));
  btn.title = open ? `Project: ${open.name}` : 'Choose a project';
}

/** @param {ProjectsView} view @param {HTMLElement} anchor */
function openSwitcherMenu(view, anchor) {
  const doc = view.doc;
  openPopover(doc, view.side, anchor, (pop, close) => {
    pop.classList.add('sb-ai-project-pop');
    for (const row of projectMenu(view.projects, view.projectId)) {
      if (row.type === 'separator') { pop.append(h(doc, 'div', 'sb-ai-pop-sep')); continue; }
      const label = row.label ?? '';
      pop.append(menuItem(doc, { label, selected: row.selected, onClick: () => {
        if (row.action === 'all') view.openProject(null);
        else if (row.action === 'open') view.openProject(row.id ?? null);
        else if (row.action === 'new') nameForm(view, anchor, { title: 'New project', cta: 'Create', onSubmit: async (name) => { const p = await view.createProject(name); view.openProject(p.id); } });
        else if (row.action === 'rename') { const p = view.projects.find((x) => x.id === view.projectId); if (p) nameForm(view, anchor, { title: 'Rename project', initial: p.name, cta: 'Save', onSubmit: (name) => view.renameProject(p.id, name) }); }
        else if (row.action === 'delete') { const p = view.projects.find((x) => x.id === view.projectId); if (p) confirmDelete(view, anchor, p); }
      } }, close));
    }
  });
}

/** A small popover with one text field. Enter or the button submits, Escape (the popover's) cancels; a refusal
 *  from the engine (blank, too long) shows under the field in plain words.
 *  @param {ProjectsView} view @param {HTMLElement} anchor
 *  @param {{ title: string, initial?: string, cta: string, onSubmit: (name: string) => Promise<unknown> }} opts */
function nameForm(view, anchor, opts) {
  const doc = view.doc;
  openPopover(doc, view.side, anchor, (pop, close) => {
    pop.classList.add('sb-ai-project-pop', 'sb-ai-project-form');
    pop.append(h(doc, 'div', 'sb-art-pop-head', opts.title));
    const input = /** @type {HTMLInputElement} */ (h(doc, 'input', 'sb-ai-project-input'));
    input.type = 'text';
    input.maxLength = 80;
    input.value = opts.initial ?? '';
    input.setAttribute('aria-label', opts.title);
    const note = h(doc, 'div', 'sb-ai-project-note');
    note.hidden = true;
    const submit = async () => {
      const name = input.value.trim();
      if (!name) { note.textContent = 'Give it a name.'; note.hidden = false; return; }
      try { await opts.onSubmit(name); close(); } catch (error) { note.textContent = String(/** @type {any} */ (error)?.message ?? error); note.hidden = false; }
    };
    input.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); void submit(); } });
    const go = h(doc, 'button', 'sb-button is-primary sb-ai-project-go', opts.cta);
    go.setAttribute('type', 'button');
    go.addEventListener('click', () => void submit());
    pop.append(input, note, go);
    view.side.ownerDocument.defaultView?.setTimeout(() => { input.focus(); input.select(); }, 0);
  });
}

/** @param {ProjectsView} view @param {HTMLElement} anchor @param {{ id: string, name: string }} project */
function confirmDelete(view, anchor, project) {
  const doc = view.doc;
  openPopover(doc, view.side, anchor, (pop, close) => {
    pop.classList.add('sb-ai-project-pop', 'sb-ai-project-form');
    pop.append(h(doc, 'div', 'sb-ai-project-ask', deleteLine(project)));
    const row = h(doc, 'div', 'sb-ai-project-buttons');
    const cancel = h(doc, 'button', 'sb-button', 'Cancel');
    cancel.setAttribute('type', 'button');
    cancel.addEventListener('click', close);
    const del = h(doc, 'button', 'sb-button is-primary', 'Delete project');
    del.setAttribute('type', 'button');
    del.addEventListener('click', () => { close(); void view.removeProject(project.id); });
    row.append(cancel, del);
    pop.append(row);
  });
}

/** The menu behind a history row's "..." or right-click. `entry` is the history entry ({kind:'chat'|'report'|'find'}).
 *  @param {ProjectsView & { canProject: boolean }} view @param {any} entry @param {HTMLElement} anchor */
export function openRowMenu(view, entry, anchor) {
  const doc = view.doc;
  return openPopover(doc, view.side, anchor, (pop, close) => {
    pop.classList.add('sb-ai-project-pop');
    for (const row of rowMenu(entry, view.projects, view.canProject)) {
      if (row.type === 'separator') { pop.append(h(doc, 'div', 'sb-ai-pop-sep')); continue; }
      if (row.type === 'heading') { pop.append(h(doc, 'div', 'sb-art-pop-head', row.label)); continue; }
      pop.append(menuItem(doc, { label: row.label ?? '', selected: row.selected, onClick: () => {
        if (row.action === 'rename') view.renameEntry(entry);
        else if (row.action === 'delete') view.deleteEntry(entry);
        else if (row.action === 'remove-from') void view.moveEntry(entry, null);
        else if (row.action === 'move') void view.moveEntry(entry, row.id ?? null);
        else if (row.action === 'new') nameForm(view, anchor, { title: 'New project', cta: 'Create and move', onSubmit: async (name) => { const p = await view.createProject(name); await view.moveEntry(entry, p.id); } });
      } }, close));
    }
  }, { className: 'sb-ai-rowmenu' });
}
