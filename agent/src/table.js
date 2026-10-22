// @ts-check
// agent-src/src/table.js. Spec 007 §1.6: the chat makes a table without a writing tool. The instructions allow one
// ```sb-table fenced JSON block per answer; after the turn `extractTableBlock` finds it, `parseTable` checks it
// against TABLE_SCHEMA, and `buildTableResult` turns it into a `table` result once each cell's `cite` has been
// resolved. Everything here is pure (citation resolution is injected), so it is testable without a runtime.

import { extractCitationRefs, citationKey } from './citations.js';

/** The shape the model is told to produce. Documentation for the model and the reader; `parseTable` enforces it. */
export const TABLE_SCHEMA = {
  type: 'object',
  required: ['columns', 'rows'],
  properties: {
    title: { type: 'string', description: 'Short name for the table' },
    revises: { type: 'string', description: 'Result id (e.g. "R3") of an existing table this replaces with a new version' },
    columns: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'string' } },
    rows: {
      type: 'array', minItems: 1, maxItems: 200,
      items: {
        type: 'object', required: ['label'],
        properties: {
          label: { type: 'string' },
          cite: { type: 'array', items: { type: 'string' }, description: 'Citations for the whole row' },
          cells: {
            type: 'object', description: 'Keyed by column name',
            additionalProperties: {
              oneOf: [{ type: 'string' }, {
                type: 'object', required: ['value'],
                properties: { value: { type: 'string' }, cite: { type: 'array', items: { type: 'string' } } },
              }],
            },
          },
        },
      },
    },
  },
};

export const TABLE_NOTICE = "Couldn't turn this into a table";

/** Added to the chat instructions (core.js). */
export const TABLE_INSTRUCTIONS = [
  'If the user asks for a table, comparison or list of items with attributes, you may put ONE fenced block in your answer, tagged sb-table, holding JSON:',
  '{"title": "...", "columns": ["Column name", ...], "rows": [{"label": "Row name", "cells": {"Column name": {"value": "...", "cite": ["[@citekey]"]}}}]}.',
  'Each cite entry follows the normal citation rules and only counts when a tool returned it. Use at most one such block per answer; write any explanation outside it.',
  'To change a table from this session, name it: add "revises": "R3" (its result id) to the block.',
].join(' ');

const BLOCK_RE = /```sb-table[^\n]*\n([\s\S]*?)```/;

/** @param {string} text @returns {{ json: string, start: number, end: number } | null} the first sb-table block */
export function extractTableBlock(text) {
  const m = BLOCK_RE.exec(text);
  return m ? { json: m[1], start: m.index, end: m.index + m[0].length } : null;
}

/** @param {string} name */
function slug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'col';
}

/** @param {unknown} v */
const isStringArray = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string');

/**
 * @typedef {{ title: string; revises: string | null; columns: string[];
 *             rows: { label: string; cite: string[]; cells: Record<string, { value: string; cite: string[] }> }[] }} ParsedTable
 */

/**
 * Parses and checks a block's JSON. Strict about structure (a wrong shape means the fallback path), lenient about
 * a cell being a bare string.
 * @param {string} json
 * @returns {{ ok: true, table: ParsedTable } | { ok: false, reason: string }}
 */
export function parseTable(json) {
  /** @type {any} */
  let data;
  try { data = JSON.parse(json); } catch { return { ok: false, reason: 'not valid JSON' }; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, reason: 'not an object' };
  const { columns, rows } = data;
  if (!isStringArray(columns) || !columns.length || columns.length > 12 || columns.some((c) => !c.trim())) return { ok: false, reason: 'columns must be 1-12 names' };
  if (!Array.isArray(rows) || !rows.length || rows.length > 200) return { ok: false, reason: 'rows must be 1-200 entries' };
  if (data.title != null && typeof data.title !== 'string') return { ok: false, reason: 'title must be text' };
  if (data.revises != null && typeof data.revises !== 'string') return { ok: false, reason: 'revises must be text' };
  const known = new Set(columns);
  /** @type {ParsedTable["rows"]} */
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || typeof row.label !== 'string' || !row.label.trim()) return { ok: false, reason: 'every row needs a label' };
    if (row.cite != null && !isStringArray(row.cite)) return { ok: false, reason: 'row cite must be a list of text' };
    const cells = row.cells ?? {};
    if (typeof cells !== 'object' || Array.isArray(cells)) return { ok: false, reason: 'cells must be an object' };
    /** @type {Record<string, { value: string; cite: string[] }>} */
    const parsedCells = {};
    for (const [name, cell] of Object.entries(cells)) {
      if (!known.has(name)) return { ok: false, reason: `unknown column "${name}"` };
      if (typeof cell === 'string') { parsedCells[name] = { value: cell, cite: [] }; continue; }
      const c = /** @type {any} */ (cell);
      if (!c || typeof c !== 'object' || typeof c.value !== 'string') return { ok: false, reason: `cell "${name}" needs a value` };
      if (c.cite != null && !isStringArray(c.cite)) return { ok: false, reason: `cell "${name}" cite must be a list of text` };
      parsedCells[name] = { value: c.value, cite: c.cite ?? [] };
    }
    out.push({ label: row.label.trim(), cite: row.cite ?? [], cells: parsedCells });
  }
  return { ok: true, table: { title: (data.title ?? '').trim() || 'Table', revises: data.revises?.trim() || null, columns: columns.map((c) => c.trim()), rows: out } };
}

/** A cite entry as the citation extractor reads it: "[@key]", "[[Note]]" and URLs pass through; a bare key is wrapped.
 *  @param {string} s */
function normalizeCite(s) {
  const t = s.trim();
  if (/^\[@.+\]$|^\[\[.+\]\]$|^https?:\/\//.test(t)) return t;
  if (/^@?[A-Za-z0-9_:.-]+$/.test(t)) return `[@${t.replace(/^@/, '')}]`;
  return t;
}

/** @param {string} s @returns {string} */
const mdCell = (s) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/**
 * A Markdown table for the fallback path. Best effort: reads whatever columns/rows the JSON has, and returns null
 * when it can't find both (the caller then keeps the raw block).
 * @param {string} json @returns {string | null}
 */
export function tableJsonToMarkdown(json) {
  /** @type {any} */
  let data;
  try { data = JSON.parse(json); } catch { return null; }
  if (!data || !Array.isArray(data.columns) || !Array.isArray(data.rows)) return null;
  const cols = data.columns.map((c) => String(c));
  const cellText = (cell) => {
    if (cell == null) return '';
    if (typeof cell === 'string') return cell;
    const cites = Array.isArray(cell.cite) ? cell.cite.map((c) => normalizeCite(String(c))).join(' ') : '';
    return [cell.value != null ? String(cell.value) : '', cites].filter(Boolean).join(' ');
  };
  const lines = [`| ${['', ...cols].map(mdCell).join(' | ')} |`, `| ${['', ...cols].map(() => '---').join(' | ')} |`];
  for (const row of data.rows) {
    if (!row || typeof row !== 'object') return null;
    const cells = row.cells && typeof row.cells === 'object' ? row.cells : {};
    lines.push(`| ${[String(row.label ?? ''), ...cols.map((c) => cellText(cells[c]))].map(mdCell).join(' | ')} |`);
  }
  return lines.join('\n');
}

/**
 * Turns a parsed table into a TableResult draft (ref/madeBy/created are filled by the caller).
 * @param {ParsedTable} table
 * @param {{
 *   resolveCite: (ref: import("./domain").CitationRef) => Promise<boolean>,  // true = the citation is valid
 *   paperRowFor: (ref: import("./domain").CitationRef) => import("./domain").RowId | null, // row in a papers result, if any
 *   priorRows?: { id: string; label: string }[],                             // rows of the table being revised
 * }} deps
 * @returns {Promise<{ result: Omit<import("./domain").TableResult, "ref" | "madeBy" | "created" | "from">, dropped: number }>}
 */
export async function buildTableResult(table, deps) {
  /** @type {import("./domain").ColumnSpec[]} */
  const columns = [];
  /** @type {Record<string, string>} */
  const idByName = {};
  const used = new Set();
  for (const name of table.columns) {
    let id = slug(name);
    for (let n = 2; used.has(id); n++) id = `${slug(name)}_${n}`;
    used.add(id);
    idByName[name] = id;
    columns.push({ id: /** @type {any} */ (id), name, instruction: '', kind: 'text' });
  }

  const validity = new Map();
  let dropped = 0;
  /** @param {string[]} cites @returns {Promise<import("./domain").CitationRef[]>} the valid refs, deduped */
  async function validRefs(cites) {
    const seen = new Set();
    /** @type {import("./domain").CitationRef[]} */
    const refs = [];
    for (const raw of cites) {
      const found = extractCitationRefs(normalizeCite(raw));
      // One cite entry that names no citation at all is dropped like an unresolved one.
      if (!found.length) { dropped += 1; continue; }
      for (const ref of found) {
        const key = citationKey(ref);
        if (!validity.has(key)) validity.set(key, await deps.resolveCite(ref));
        if (!validity.get(key)) { dropped += 1; continue; }
        if (!seen.has(key)) { seen.add(key); refs.push(ref); }
      }
    }
    return refs;
  }

  const prior = new Map((deps.priorRows ?? []).map((r) => [r.label.trim().toLowerCase(), r.id]));
  let next = 1 + (deps.priorRows ?? []).reduce((m, r) => Math.max(m, Number(/^x:(\d+)$/.exec(r.id)?.[1] ?? 0)), 0);
  const takenIds = new Set();
  /** @type {import("./domain").TableResult["rows"]} */
  const rows = [];
  /** @type {import("./domain").TableResult["cells"]} */
  const cells = {};
  for (const row of table.rows) {
    let id = prior.get(row.label.toLowerCase());
    if (!id || takenIds.has(id)) id = `x:${next++}`;
    takenIds.add(id);
    const rowId = /** @type {import("./domain").RowId} */ (id);
    const rowRefs = await validRefs(row.cite);
    /** @type {Record<string, import("./domain").Cell>} */
    const rowCells = {};
    const allRefs = [...rowRefs];
    for (const name of table.columns) {
      const cell = row.cells[name];
      if (!cell || !cell.value.trim()) { rowCells[idByName[name]] = { state: 'not_found', note: 'Not stated' }; continue; }
      const refs = await validRefs(cell.cite);
      allRefs.push(...refs);
      rowCells[idByName[name]] = { state: 'filled', value: cell.value, quotes: [], citations: refs };
    }
    const distinct = new Map(allRefs.filter((r) => r.kind === 'paper' || r.kind === 'web').map((r) => [citationKey(r), r]));
    const only = distinct.size === 1 ? [...distinct.values()][0] : null;
    rows.push({ id: rowId, label: row.label, paper: only ? deps.paperRowFor(only) : null });
    cells[rowId] = /** @type {any} */ (rowCells);
  }

  return {
    result: { kind: 'table', title: table.title, columns, rows, cells, change: '' },
    dropped,
  };
}
