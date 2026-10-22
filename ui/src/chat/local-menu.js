// @ts-check
// ui-src/src/chat/local-menu.js (spec 010 §6). The "Answer with" button in the chat's controls row and its menu: Cloud, or
// one of the models on this Mac. It moves the Chat and Ask roles together (the same state Settings shows) and is hidden
// when the engine has no "On this Mac" provider or the mode is not Chat / Quick answer.
import { h } from '../dom.js';
import { icon } from '../icons.js';
import { openPopover, menuItem } from './popover.js';
import { HONEST_NOTE, CLOUD_ROLES_KEY, buttonLabel, menuGroups, readyCloud, selectedId, planSwitch, planCloudModel, planDefault, cloudRows, statusLines, isLocal } from './local-menu-data.js';
import { parseKey, modelKey } from '../settings/models-data.js';

export class LocalMenu {
  /** @param {any} view the ChatView (host, doc, box) */
  constructor(view) {
    this.view = view;
    this.doc = view.doc;
    this.available = false;
    /** @type {Record<string, import("../../../agent/src/domain").ModelChoice | null | undefined>} */
    this.roles = {};
    /** @type {import("../../../agent/src/domain").LocalModel[]} */
    this.models = [];
    /** @type {import("../../../agent/src/domain").ProviderStatus | null} */
    this.status = null;
    /** @type {string[]} */ this.ready = [];
    /** spec 016: the engine's settings (shownModels, defaultModel), and the model lists the ticked models are named from. */
    /** @type {any} */ this.settings = {};
    /** @type {Record<string, import("../../../agent/src/domain").ListedModel[]>} */ this.cloudLists = {};
    this.button = /** @type {HTMLButtonElement} */ (h(this.doc, 'button', 'sb-ai-localbtn'));
    this.button.type = 'button';
    this.button.title = 'Which model answers your questions: your usual cloud model, or one that runs on this Mac';
    this.button.hidden = true;
    this.button.addEventListener('click', () => { if (this.pop) this.pop.close(); else void this.open(); });
    /** @type {{ el: HTMLElement, close: () => void } | null} */
    this.pop = null;
    this.modeOk = true;
  }

  /** Loads status, models and roles; shows or hides the button. Never throws. */
  async refresh() {
    try {
      const ai = await this.view.host.ai();
      const statuses = await ai.providers.status();
      this.ready = readyCloud(statuses);
      this.status = statuses.find((/** @type {any} */ s) => s.provider === 'local') ?? null;
      [this.settings, this.roles] = await Promise.all([ai.settings.get().catch(() => ({})), ai.providers.roles().catch(() => ({}))]);
      const shown = this.settings.shownModels ?? [];
      this.available = Boolean(this.status) || shown.length > 0;
      if (this.status) this.models = await ai.providers.models('local').catch(() => []);
      // the ticked models are named by their provider's list; the one Chat is on is looked up too, so the button can name it
      const providers = new Set([...shown.map((/** @type {string} */ k) => parseKey(k).provider), ...(this.roles.chat && this.roles.chat.provider !== 'local' ? [this.roles.chat.provider] : [])]);
      this.cloudLists = {};
      await Promise.all([...providers].map(async (p) => { this.cloudLists[p] = await ai.providers.models(p).catch(() => []); }));
    } catch {
      this.available = false;
    }
    this.paint();
  }

  /** @param {string} mode */
  setMode(mode) { this.modeOk = mode === 'chat' || mode === 'ask'; this.paint(); }

  /** model key -> the name its provider gives it, for the button. */
  cloudLabels() {
    return Object.fromEntries(Object.entries(this.cloudLists).flatMap(([provider, list]) => list.map((m) => [modelKey(provider, m.id), m.label])));
  }

  paint() {
    this.button.hidden = !(this.available && this.modeOk);
    this.button.replaceChildren(icon(this.doc, 'chat', 'sb-ai-icon'), h(this.doc, 'span', 'sb-ai-localbtn-text', buttonLabel(this.roles, this.models, this.cloudLabels())));
    this.button.classList.toggle('is-local', isLocal(this.roles));
  }

  async open() {
    await this.refresh();
    if (!this.available) return;
    const selected = selectedId(this.roles, this.models);
    const cloud = !isLocal(this.roles);
    const rows = cloudRows(this.settings.shownModels ?? [], this.cloudLists, this.roles);
    const patch = planDefault(this.settings, this.roles);
    this.button.classList.add('is-open');
    const { top, more } = menuGroups(this.models, selected);
    /** @type {{ el: HTMLElement, close: () => void, place: () => void } | null} */
    let popover = null;
    const row = (/** @type {ReturnType<typeof menuGroups>["top"][number]} */ r, /** @type {() => void} */ close) =>
      menuItem(this.doc, { label: r.label, hint: r.hint, selected: r.id === selected, disabled: r.disabled, onClick: () => this.choose(r.id) }, close);
    popover = this.pop = openPopover(this.doc, this.view.box, this.button, (pop, close) => {
      pop.classList.add('sb-local-pop');
      pop.append(h(this.doc, 'div', 'sb-art-pop-head', 'Answer with'));
      if (rows.length) {
        pop.append(h(this.doc, 'div', 'sb-art-pop-head', 'Cloud'));
        for (const r of rows) pop.append(menuItem(this.doc, { label: r.label, hint: r.hint, selected: r.selected, onClick: () => this.choose(r.choice) }, close));
      } else {
        pop.append(menuItem(this.doc, { label: 'Cloud', hint: 'Your usual model (Codex or Claude Code)', selected: cloud, onClick: () => this.choose(null) }, close));
      }
      if (this.status && !top.length && !more.length) pop.append(h(this.doc, 'div', 'sb-local-empty', 'No models found.'));
      if (top.length) pop.append(h(this.doc, 'div', 'sb-art-pop-head', 'On this Mac'));
      for (const r of top) pop.append(row(r, close));
      if (more.length) {
        const toggle = /** @type {HTMLButtonElement} */ (h(this.doc, 'button', 'sb-local-more'));
        toggle.type = 'button';
        toggle.setAttribute('aria-expanded', 'false');
        toggle.append(icon(this.doc, 'chevron', 'sb-ai-icon sb-local-more-chev'), h(this.doc, 'span', '', `More models (${more.length})`));
        const list = h(this.doc, 'div', 'sb-local-more-list');
        list.hidden = true;
        for (const r of more) list.append(row(r, close));
        toggle.addEventListener('click', (event) => {
          event.stopPropagation();
          list.hidden = !list.hidden;
          toggle.setAttribute('aria-expanded', String(!list.hidden));
          toggle.classList.toggle('is-open', !list.hidden);
          popover?.place();
        });
        pop.append(toggle, list);
      }
      for (const line of statusLines(this.status)) pop.append(h(this.doc, 'div', 'sb-local-status', line));
      if (this.status) pop.append(h(this.doc, 'div', 'sb-local-note', HONEST_NOTE));
      if (patch) {
        const link = /** @type {HTMLButtonElement} */ (h(this.doc, 'button', 'sb-local-default', 'Set as default'));
        link.type = 'button';
        link.addEventListener('click', () => { close(); void this.setDefault(patch); });
        pop.append(link);
      } else if (this.roles.chat) {
        pop.append(h(this.doc, 'div', 'sb-local-default is-current', 'This is the default'));
      }
    }, { above: true, onClose: () => { this.pop = null; this.button.classList.remove('is-open'); } });
  }

  /** @param {import("../../../agent/src/settings").SettingsPatch} patch from planDefault */
  async setDefault(patch) {
    try {
      const ai = await this.view.host.ai();
      this.settings = await ai.settings.update(patch);
    } catch (error) {
      this.view.host.notice(String(/** @type {any} */ (error)?.message ?? error));
    }
  }

  /** @param {string | import("../../../agent/src/domain").ModelChoice | null} target a local model id, a cloud model's choice, or null for Cloud */
  async choose(target) {
    try {
      const ai = await this.view.host.ai();
      const saved = this.view.host.prefs.get(CLOUD_ROLES_KEY);
      const plan = target && typeof target === 'object' ? planCloudModel(target) : planSwitch({ target, roles: this.roles, saved, ready: this.ready });
      for (const { role, choice } of plan.set) await ai.providers.setRole(role, choice);
      if (plan.saveCloud) this.view.host.prefs.set(CLOUD_ROLES_KEY, plan.saveCloud);
      this.roles = await ai.providers.roles();
    } catch (error) {
      this.view.host.notice(String(/** @type {any} */ (error)?.message ?? error));
    }
    this.paint();
  }

  destroy() { this.pop?.close(); }
}
