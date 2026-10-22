// @ts-check
// ui-src/src/chat/skills-data.js. Spec 011 U3: the pure part of the Skills dialog (tabs, search, turning an upload, a
// draft or the by-hand form into a SKILL.md). No DOM, so the same logic is tested in node.
import { skillFile, parseSkill, validName } from '../../../agent-src/src/skills.js';

export const TABS = /** @type {const} */ ([['all', 'All'], ['mine', 'By you'], ['builtin', 'Built-in']]);

/** @typedef {import("../../../agent-src/src/skills.js").SkillSummary} SkillSummary */

/**
 * What the list shows for a tab and a search. A search looks at the name and the description, ignoring case.
 * @param {SkillSummary[]} list @param {"all" | "mine" | "builtin"} tab @param {string} query
 */
export function filterSkills(list, tab, query) {
  const q = query.trim().toLowerCase();
  return list.filter((s) => (tab === 'all' || (tab === 'mine' ? s.source === 'user' : s.source === 'builtin'))
    && (!q || `${s.name} ${s.description}`.toLowerCase().includes(q)));
}

/** @param {string} name */
export function safeName(name) {
  return name.replace(/\.(md|markdown|txt)$/i, '').replace(/[^A-Za-z0-9 ._-]+/g, ' ').replace(/\s+/g, ' ').replace(/^[ ._-]+|[ .]+$/g, '').slice(0, 64).trim();
}

/**
 * The editor's three fields for a file. A SKILL.md that reads is split into name, description and instructions; any other
 * text (a plain .md, a broken skill) becomes the instructions under a name taken from `fallbackName`, so nothing typed
 * is lost and the user fixes it before saving.
 * @param {string} text @param {string} fallbackName
 * @returns {{ name: string, description: string, instructions: string }}
 */
export function fieldsFromFile(text, fallbackName) {
  const guess = (text.match(/^﻿?---[ \t]*\r?\n[\s\S]*?^name:[ \t]*(.+?)[ \t]*$/m)?.[1] ?? '').replace(/^(["'])(.*)\1$/, '$2');
  const parsed = parseSkill(text, guess || safeName(fallbackName));
  if (parsed.ok) return { name: parsed.name, description: parsed.description, instructions: parsed.body };
  const stripped = text.replace(/^﻿?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '').trim();
  const firstLine = (stripped.split(/\r?\n/).find((l) => l.trim()) ?? '').replace(/^#+\s*/, '').slice(0, 120);
  return { name: safeName(fallbackName) || 'New skill', description: firstLine, instructions: stripped || text.trim() };
}

/** Why the form cannot be saved yet, or null. @param {{ name: string, description: string, instructions: string }} f @param {string[]} [taken] names that would be overwritten without `overwrite` */
export function formProblem(f, taken = []) {
  if (!f.name.trim()) return 'Give the skill a name.';
  if (!validName(f.name.trim())) return 'A name uses letters, digits, spaces, "." "_" or "-" (up to 64) and no slashes.';
  if (!f.description.trim()) return 'Say in one line when to use it.';
  if (!f.instructions.trim()) return 'Write the instructions.';
  if (taken.includes(f.name.trim())) return `You already have a skill called “${f.name.trim()}”.`;
  return null;
}

/** The SKILL.md for the form. @param {{ name: string, description: string, instructions: string }} f */
export function fileFromFields(f) {
  return skillFile({ name: f.name.trim(), description: f.description, body: f.instructions });
}

/** The composer chip's text. @param {string} name */
export const chipText = (name) => name;

/** The line under a message that used skills. @param {string[] | undefined} names */
export function usedLine(names) {
  return names?.length ? `Skill${names.length === 1 ? '' : 's'}: ${names.join(', ')}` : '';
}
