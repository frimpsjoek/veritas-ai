// @ts-check
// ui-src/src/chat/local-menu-data.js (spec 010 §6). The pure parts of the "Answer with" menu: labels, rows, and what
// choosing a row changes. No DOM, so node --test covers it.
import { shownList, providerName, modelKey, choiceKey } from '../settings/models-data.js';
import { useOneDefault } from '../../../agent/src/settings.js';

export const HONEST_NOTE = 'Runs on your Mac and can get facts wrong. Check the passages under each answer.';
export const CLOUD_ROLES_KEY = 'cloudRoles';
/** The roles the menu moves together: the two that answer questions. */
export const MENU_ROLES = /** @type {const} */ (['chat', 'ask']);

/** @typedef {import("../../../agent/src/domain").ModelChoice} ModelChoice */
/** @typedef {import("../../../agent/src/domain").LocalModel} LocalModel */

/** @param {number | null | undefined} bytes */
export function formatSize(bytes) {
  if (!bytes || bytes <= 0) return '';
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

/** @param {Record<string, ModelChoice | null | undefined> | null | undefined} roles */
export function isLocal(roles) { return roles?.chat?.provider === 'local'; }

/** What the button says: the chosen cloud model's name ("Sonnet"), "Cloud" when Chat has no model named, or
 *  "On this Mac: <model>". @param {Record<string, ModelChoice | null | undefined> | null | undefined} roles @param {LocalModel[]} models
 *  @param {Record<string, string>} [cloudLabels] model key -> the name the provider gives it */
export function buttonLabel(roles, models, cloudLabels = {}) {
  if (!isLocal(roles)) {
    const chat = roles?.chat;
    return chat?.model ? (cloudLabels[modelKey(chat.provider, chat.model)] ?? chat.model) : 'Cloud';
  }
  const id = roles?.chat?.model;
  const model = (id ? models.find((m) => m.id === id) : models.find((m) => m.isDefault)) ?? null;
  return `On this Mac: ${model?.label ?? 'default model'}`;
}

/** The model has been tried on this library, so its note says something. @param {LocalModel} m */
export function isTested(m) { return !/not tested on your library/i.test(m.note ?? ''); }

/** The first sentence of a note: one short line per model. @param {string | null | undefined} note */
function firstSentence(note) {
  const text = String(note ?? '').trim();
  return text.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? text;
}

/** @param {LocalModel} m @returns {{ id: string, label: string, hint: string, disabled: boolean }} */
function modelRow(m) {
  const note = m.unavailable ? m.unavailable : isTested(m) ? firstSentence(m.note) : '';
  return { id: m.id, label: m.label, hint: [formatSize(m.sizeBytes), note].filter(Boolean).join(' \u00b7 '), disabled: Boolean(m.unavailable) };
}

/** @param {LocalModel[]} models */
export function modelRows(models) { return models.map(modelRow); }

/** The model rows, split for the menu: the tested ones (and the selected one, tested or not) first, the untested ones
 *  behind "More models (N)". @param {LocalModel[]} models @param {string | null} selected
 *  @returns {{ top: ReturnType<typeof modelRow>[], more: ReturnType<typeof modelRow>[] }} */
export function menuGroups(models, selected) {
  const keep = (/** @type {LocalModel} */ m) => isTested(m) || m.id === selected;
  return { top: models.filter(keep).map(modelRow), more: models.filter((m) => !keep(m)).map(modelRow) };
}

/** Which row is selected: the model Chat uses, else the default one when Chat is local with no model named.
 *  @param {Record<string, ModelChoice | null | undefined> | null | undefined} roles @param {LocalModel[]} models @returns {string | null} */
export function selectedId(roles, models) {
  if (!isLocal(roles)) return null;
  return roles?.chat?.model ?? models.find((m) => m.isDefault)?.id ?? null;
}

/** The ticked cloud models as menu rows: label, the provider under it, and the choice a click sets. `selected` is the row Chat is on.
 *  @param {string[]} shown settings.shownModels @param {Record<string, import("../../../agent/src/domain").ListedModel[]>} lists
 *  @param {Record<string, ModelChoice | null | undefined> | null | undefined} roles */
export function cloudRows(shown, lists, roles) {
  const now = isLocal(roles) ? '' : choiceKey(roles?.chat);
  return shownList(shown, lists).map((r) => ({ id: r.key, label: r.label, hint: providerName(r.provider), selected: r.key === now, choice: /** @type {ModelChoice} */ ({ provider: /** @type {any} */ (r.provider), model: r.model }) }));
}

/** Choosing a cloud model moves Chat and Ask together, like the Mac models do. @param {ModelChoice} choice
 *  @returns {{ set: { role: "chat" | "ask", choice: ModelChoice }[], saveCloud: null }} */
export function planCloudModel(choice) {
  return { set: MENU_ROLES.map((role) => ({ role, choice: { ...choice } })), saveCloud: null };
}

/** "Set as default": the settings patch that makes what Chat uses now the one default (and clears the tasks already equal
 *  to it), or null when it already is. @param {{ roles?: any, defaultModel?: ModelChoice | null }} settings
 *  @param {Record<string, ModelChoice | null | undefined> | null | undefined} roles */
export function planDefault(settings, roles) {
  const choice = roles?.chat;
  if (!choice) return null;
  const def = settings.defaultModel;
  if (def && choiceKey(def) === choiceKey(choice) && (def.effort ?? '') === (choice.effort ?? '')) return null;
  return useOneDefault({ roles: settings.roles ?? roles }, choice);
}

/** The cloud providers in the order the menu prefers them. */
export const CLOUD_PROVIDERS = ['codex', 'claude'];

/** The ready cloud providers, in preference order. @param {{ provider: string, state: string }[] | null | undefined} statuses @returns {string[]} */
export function readyCloud(statuses) {
  return CLOUD_PROVIDERS.filter((id) => statuses?.some((s) => s.provider === id && s.state === 'ready'));
}

/** The cloud choice to put back: the saved one, else what the roles say now (when they are cloud), else the first ready
 *  cloud provider (Codex, then Claude Code), else Codex.
 *  @param {Record<string, ModelChoice> | null | undefined} saved @param {Record<string, ModelChoice | null | undefined> | null | undefined} roles
 *  @param {"chat" | "ask"} role @param {string[]} [ready] @returns {ModelChoice} */
export function cloudChoice(saved, roles, role, ready = []) {
  const s = saved?.[role];
  if (s && s.provider !== 'local') return s;
  const now = roles?.[role];
  if (now && now.provider !== 'local') return now;
  return { provider: /** @type {any} */ (ready[0] ?? 'codex'), model: null };
}

/**
 * @param {{ target: string | null, roles: Record<string, ModelChoice | null | undefined>, saved: Record<string, ModelChoice> | null | undefined, ready?: string[] }} args
 *   `target` = a local model id, or null for Cloud.
 * @returns {{ set: { role: "chat" | "ask", choice: ModelChoice }[], saveCloud: Record<string, ModelChoice> | null }}
 */
export function planSwitch({ target, roles, saved, ready = [] }) {
  if (target === null) {
    return { set: MENU_ROLES.map((role) => ({ role, choice: cloudChoice(saved, roles, role, ready) })), saveCloud: null };
  }
  /** @type {Record<string, ModelChoice> | null} */
  let saveCloud = null;
  if (!isLocal(roles)) {
    saveCloud = Object.fromEntries(MENU_ROLES.map((role) => [role, cloudChoice(saved, roles, role, ready)]));
  }
  return { set: MENU_ROLES.map((role) => ({ role, choice: { provider: 'local', model: target } })), saveCloud };
}

/** The lines under the model list, from the provider status. A ready provider says nothing ("3 models found" is clutter).
 *  @param {{ state: string, detail?: string | null, installHelp?: string | null } | null} status @returns {string[]} */
export function statusLines(status) {
  if (!status || status.state === 'ready') return [];
  /** @type {string[]} */
  const lines = [];
  if (status.detail) lines.push(status.detail);
  if (status.installHelp && status.state !== 'loading') lines.push(status.installHelp);
  return lines;
}
