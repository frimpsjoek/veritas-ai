// @ts-check
// ui-src/src/export/save.js. Getting an export onto disk, in the order a host can do it: `host.saveFile` (the host
// picks the place: Zotero a save dialog, Obsidian a vault folder), else `host.exportRows` for CSV and RIS (the
// Find papers path every host already has), else a Blob download when the document is an ordinary browser page
// (the shared harness). A host with none of them gets no Download menu at all: the UI hides, never greys out.
import { XHTML_NS } from '../dom.js';

/** @typedef {import("../host").UiHost} UiHost */
/** @typedef {"csv" | "ris" | "md"} ExportFormat */

export const MIME = { csv: 'text/csv', ris: 'application/x-research-info-systems', md: 'text/markdown' };

/** @param {Document} doc */
function blobOk(doc) {
  const win = /** @type {any} */ (doc.defaultView);
  return Boolean(win?.Blob && win.URL?.createObjectURL && doc.body);
}

/** Whether Download can do anything for this format on this host. @param {UiHost} host @param {Document} doc @param {ExportFormat} format */
export function canSave(host, doc, format) {
  return Boolean(host.saveFile || (typeof host.exportRows === 'function' && format !== 'md') || blobOk(doc));
}

/**
 * @param {UiHost} host @param {Document} doc @param {ExportFormat} format @param {string} name file name with extension
 * @param {string} text
 * @returns {Promise<{ path?: string } | void>}
 */
export async function saveText(host, doc, format, name, text) {
  if (host.saveFile) return host.saveFile(name, text, MIME[format]);
  if (typeof host.exportRows === 'function' && format !== 'md') { await host.exportRows(text, format, name); return; }
  const win = /** @type {any} */ (doc.defaultView);
  const link = /** @type {HTMLAnchorElement} */ (doc.createElementNS(XHTML_NS, 'a'));
  link.href = win.URL.createObjectURL(new win.Blob([text], { type: MIME[format] }));
  link.download = name;
  doc.body.append(link);
  link.click();
  link.remove();
  win.setTimeout(() => win.URL.revokeObjectURL(link.href), 4000);
}

/** A file-name-safe version of a title. @param {string} title @param {string} fallback */
export function fileStem(title, fallback) {
  return title.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || fallback;
}
