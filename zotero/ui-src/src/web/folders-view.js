// @ts-check
// ui-src/src/web/folders-view.js (server spec 018 G4). Settings > Folders: the folders the search index reads, each
// recognised by what is in it (a Zotero library, an Obsidian vault, or a plain folder of notes and PDFs), with its
// count, an on/off switch and Remove, and Add folder. Named Folders because the radar already owns "Sources".
import { h } from '../dom.js';
import { progressPanel } from './progress-view.js';

const KIND = /** @type {Record<string, string>} */ ({
  zotero: 'Zotero library', obsidian: 'Obsidian vault', plain: 'Folder', missing: 'Not found',
});
const ROLE = /** @type {Record<string, string>} */ ({
  main: 'main folder: notes Second Brain writes go here', zotero: '', listed: '', off: 'switched off',
  ignored: 'not read: a second Zotero library, or the folder is not there',
});

/** @param {Document} doc @param {string} text @param {() => void | Promise<void>} onClick */
function button(doc, text, onClick) {
  const b = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sb-button', text));
  b.type = 'button';
  b.addEventListener('click', () => void onClick());
  return b;
}

/** @param {any} f */
export function folderDetail(f) {
  const count = f.role === 'off' ? '' : `${f.documents} document${f.documents === 1 ? '' : 's'}`;
  return [KIND[f.kind] ?? f.kind, count, ROLE[f.role] ?? ''].filter(Boolean).join(' · ');
}

/** @param {Document} doc @param {any} host */
export function foldersWidget(doc, host) {
  const root = h(doc, 'div', 'sbw-folders');
  root.id = 'sbw-folders';
  const list = h(doc, 'div', 'sbw-list');
  const form = /** @type {HTMLFormElement} */ (h(doc, 'form', 'sbw-folders-add'));
  const path = /** @type {HTMLInputElement} */ (h(doc, 'input', 'sb-input'));
  path.placeholder = '/Users/you/Documents/Papers';
  path.setAttribute('aria-label', 'Folder path on the server computer');
  const name = /** @type {HTMLInputElement} */ (h(doc, 'input', 'sb-input'));
  name.placeholder = 'name (optional)';
  name.setAttribute('aria-label', 'Short name for the folder');
  const add = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sb-button', 'Add folder'));
  add.type = 'submit';
  const note = h(doc, 'p', 'sbw-hint');
  form.append(path, name, add);
  root.append(progressPanel(doc, host), list, form, note);

  const say = (/** @type {unknown} */ error) => { note.textContent = String(/** @type {any} */ (error)?.message ?? error); };
  const refresh = async () => {
    let report;
    try { report = await host.json('/sources'); } catch (error) {
      list.replaceChildren(h(doc, 'p', 'sbw-hint', "Couldn't read the folder list."));
      return;
    }
    const rows = report.folders.map((/** @type {any} */ f) => {
      const row = h(doc, 'div', `sbw-row sbw-folder is-${f.role}`);
      const text = h(doc, 'div', 'sbw-folder-text');
      text.append(h(doc, 'span', 'sbw-row-name', f.name), h(doc, 'span', 'sbw-row-detail', folderDetail(f)),
        h(doc, 'span', 'sbw-folder-path', f.path));
      const toggle = /** @type {HTMLLabelElement} */ (h(doc, 'label', 'sbw-folder-on'));
      const box = /** @type {HTMLInputElement} */ (h(doc, 'input'));
      box.type = 'checkbox';
      box.checked = Boolean(f.enabled);
      box.setAttribute('aria-label', `Read ${f.name}`);
      box.addEventListener('change', async () => {
        try { await host.json(`/sources/${encodeURIComponent(f.name)}`, 'PATCH', { enabled: box.checked }); note.textContent = 'Saved; the index is updating.'; } catch (e) { say(e); }
        await refresh();
      });
      toggle.append(box, h(doc, 'span', '', 'On'));
      const remove = button(doc, 'Remove', async () => {
        if (!doc.defaultView?.confirm(`Stop reading ${f.name}? Its files stay where they are; only the index forgets them.`)) return;
        try { await host.json(`/sources/${encodeURIComponent(f.name)}`, 'DELETE'); note.textContent = 'Removed.'; } catch (e) { say(e); }
        await refresh();
      });
      row.append(text, toggle, remove);
      return row;
    });
    if (!report.main_is_vault) {
      const home = h(doc, 'div', 'sbw-row sbw-folder is-main');
      const text = h(doc, 'div', 'sbw-folder-text');
      text.append(h(doc, 'span', 'sbw-row-name', 'Home folder'),
        h(doc, 'span', 'sbw-row-detail', `${report.main_documents ?? 0} documents · AI notes and digests are saved here (no Obsidian vault in the list)`),
        h(doc, 'span', 'sbw-folder-path', report.main));
      home.append(text);
      rows.push(home);
    }
    list.replaceChildren(...(rows.length ? rows : [h(doc, 'p', 'sbw-hint', 'No folders yet.')]));
  };
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!path.value.trim()) { say('Type the folder path on the computer that runs Second Brain.'); return; }
    add.disabled = true;
    try {
      const added = await host.json('/sources', 'POST', { path: path.value.trim(), ...(name.value.trim() ? { name: name.value.trim() } : {}) });
      note.textContent = `Added ${added.name} (${KIND[added.kind] ?? added.kind}); the index is reading it.`;
      path.value = ''; name.value = '';
    } catch (e) { say(e); }
    add.disabled = false;
    await refresh();
  });
  void refresh();
  return root;
}
