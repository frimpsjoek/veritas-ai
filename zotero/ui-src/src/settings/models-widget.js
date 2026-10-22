// @ts-check
// ui-src/src/settings/models-widget.js (spec 016 U3). The Models section of Settings, the same in Zotero, Obsidian and
// the web app: a default model with a collapsed per-task list, one row per cloud provider with the models it can show
// in the Answer-with menu, a side drawer to add another service, and a link to On this Mac. All reading and writing is
// in models-data.js; this file draws.
import { h } from '../dom.js';
import {
  ModelsStore, TASKS, EFFORT_LABELS, providerName, providerState, cloudProviders, statusOf, pickableModels, checklist, effortsFor,
  choiceKey, normalizeAddress, endpointProblem,
} from './models-data.js';

/** @param {Document} doc @param {string} text @param {string} [cls] @param {() => void | Promise<void>} [onClick] */
function textButton(doc, text, cls, onClick) {
  const b = /** @type {HTMLButtonElement} */ (h(doc, 'button', cls ?? 'sbm-link', text));
  b.type = 'button';
  if (onClick) b.addEventListener('click', () => void onClick());
  return b;
}

/** @param {Document} doc @param {string} label @param {[string, string][]} options @param {string} value @param {(v: string) => void} onChange */
function select(doc, label, options, value, onChange) {
  const el = /** @type {HTMLSelectElement} */ (h(doc, 'select', 'sbs-select sbm-select'));
  el.setAttribute('aria-label', label);
  for (const [v, text] of options) { const o = /** @type {HTMLOptionElement} */ (h(doc, 'option', '', text)); o.value = v; el.append(o); }
  el.value = value;
  el.addEventListener('change', () => onChange(el.value));
  return el;
}

/** @param {Document} doc @param {any} host @param {{ select?: (section: string) => void }} [ctx] */
export function modelsWidget(doc, host, ctx = {}) {
  const root = h(doc, 'div', 'sbm');
  /** @type {ModelsStore | null} */
  let store = null;
  let perTaskOpen = false;
  /** @type {Record<string, boolean>} */
  const helpOpen = {};
  /** @type {Record<string, boolean>} */
  const addOpen = {};
  /** @type {HTMLElement | null} */
  let drawer = null;

  const say = (/** @type {unknown} */ error) => { host.logError?.(error); host.notice?.(String(/** @type {any} */ (error)?.message ?? error)); };
  /** Runs a write, then redraws from what the engine now holds. @param {() => Promise<unknown>} fn */
  const act = async (fn) => { try { await fn(); } catch (error) { say(error); } paint(); };

  /** @param {string} title */
  const group = (title) => { const g = h(doc, 'section', 'sbm-group'); g.append(h(doc, 'h3', 'sbm-head', title)); return g; };

  /** @param {string} label @param {string} help @param {HTMLElement[]} controls */
  const row = (label, help, controls) => {
    const r = h(doc, 'div', 'sbm-row');
    const text = h(doc, 'div', 'sbs-text');
    text.append(h(doc, 'span', 'sbs-label', label));
    if (help) text.append(h(doc, 'span', 'sbs-help', help));
    const ctl = h(doc, 'div', 'sbm-ctl');
    ctl.append(...controls);
    r.append(text, ctl);
    return r;
  };

  /** A model select and, when that model has efforts, an effort select. @param {import("./models-data.js").ModelsState} state
   *  @param {{ label: string, current: import("../../../agent-src/src/domain").ModelChoice | null, first: [string, string], save: (value: string, effort?: string) => void }} o */
  const modelControls = (state, o) => {
    const now = o.current && choiceKey(o.current);
    const options = /** @type {[string, string][]} */ ([o.first, ...pickableModels(state, o.current).map((m) => /** @type {[string, string]} */ ([m.value, m.label]))]);
    const model = select(doc, o.label, options, now ?? '', (v) => o.save(v));
    const out = [model];
    const efforts = o.current ? effortsFor(state, o.current.provider, o.current.model) : [];
    if (now && efforts.length) {
      out.push(select(doc, `${o.label}: effort`, [['', 'Effort: default'], ...efforts.map((e) => /** @type {[string, string]} */ ([e, `Effort: ${EFFORT_LABELS[e] ?? e}`]))], o.current?.effort ?? '', (e) => o.save(now, e)));
    }
    return out;
  };

  /** True when a role follows the default. @param {import("../../../agent-src/src/settings").Settings} settings @param {import("../../../agent-src/src/domain").ModelChoice | null | undefined} choice */
  const follows = (settings, choice) => {
    if (!choice) return true;
    const def = settings.defaultModel;
    if (def) return choiceKey(choice) === choiceKey(def) && (choice.effort ?? '') === (def.effort ?? '');
    return !choice.model && !choice.effort;
  };

  const paintDefaults = (/** @type {import("./models-data.js").ModelsState} */ state) => {
    const g = group('Default');
    const s = /** @type {ModelsStore} */ (store);
    g.append(row('Default model', 'Used for everything unless a task below says otherwise.', modelControls(state, {
      label: 'Default model', current: state.settings.defaultModel, first: ['', 'Automatic'],
      save: (v, e) => void act(() => s.saveDefault(v, e)),
    })));
    const roles = /** @type {Record<string, any>} */ (state.settings.roles ?? {});
    const different = TASKS.filter(([role]) => !follows(state.settings, roles[role]));
    const summary = different.length ? `${different.length} set differently` : 'All same as default';
    const toggle = textButton(doc, perTaskOpen ? 'Done' : 'Change ›', 'sbm-link', () => { perTaskOpen = !perTaskOpen; paint(); });
    toggle.setAttribute('aria-expanded', String(perTaskOpen));
    g.append(row('Per task', 'Chat, Quick answer, Planning, Researching, Writing, Reading papers.', [h(doc, 'span', 'sbm-quiet', summary), toggle]));
    if (perTaskOpen) {
      const list = h(doc, 'div', 'sbm-tasks');
      for (const [role, name] of TASKS) {
        const current = follows(state.settings, roles[role]) ? null : roles[role];
        list.append(row(name, '', current ? modelControls(state, { label: name, current, first: ['', 'Same as default'], save: (v, e) => void act(() => s.saveTask(role, v, e)) })
          : [select(doc, name, [['', 'Same as default'], ...pickableModels(state, null).map((m) => /** @type {[string, string]} */ ([m.value, m.label]))], '', (v) => void act(() => s.saveTask(role, v)))]));
      }
      g.append(list);
    }
    return g;
  };

  /** @param {import("./models-data.js").ModelsState} state @param {string} provider */
  const modelList = (state, provider) => {
    const s = /** @type {ModelsStore} */ (store);
    const box = h(doc, 'div', 'sbm-models');
    for (const m of checklist(state, provider)) {
      const label = /** @type {HTMLLabelElement} */ (h(doc, 'label', 'sbm-model'));
      const check = /** @type {HTMLInputElement} */ (h(doc, 'input'));
      check.type = 'checkbox';
      check.checked = m.on;
      check.dataset.model = `${provider}:${m.id}`;
      check.addEventListener('change', () => void act(() => s.tick(provider, m.id, check.checked)));
      label.append(check, h(doc, 'span', 'sbm-model-name', m.label));
      if (m.hint) label.append(h(doc, 'span', 'sbm-model-hint', m.hint));
      box.append(label);
    }
    if (addOpen[provider]) {
      const form = h(doc, 'form', 'sbm-add');
      const input = /** @type {HTMLInputElement} */ (h(doc, 'input', 'sbs-input sbm-add-input'));
      input.placeholder = provider === 'codex' ? 'A model ID, like gpt-5.5' : 'A model ID, like claude-sonnet-4-5-20250929';
      input.setAttribute('aria-label', `Model ID for ${providerName(provider)}`);
      input.autocomplete = 'off';
      const add = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sb-button', 'Add'));
      add.type = 'submit';
      form.append(input, add, textButton(doc, 'Cancel', 'sbm-link', () => { addOpen[provider] = false; paint(); }));
      form.addEventListener('submit', (event) => { event.preventDefault(); void act(async () => { if (await s.addModelId(provider, input.value)) addOpen[provider] = false; }); });
      box.append(form);
      queueMicrotask(() => input.focus());
    } else {
      box.append(textButton(doc, '+ Add a model ID', 'sbm-link sbm-add-link', () => { addOpen[provider] = true; paint(); }));
    }
    return box;
  };

  const paintCloud = (/** @type {import("./models-data.js").ModelsState} */ state) => {
    const g = group('Cloud');
    const s = /** @type {ModelsStore} */ (store);
    for (const provider of cloudProviders(state)) {
      const info = providerState(statusOf(state, provider), provider);
      const pill = h(doc, 'span', `sbm-pill${info.ok ? '' : ' is-off'}`, info.pill);
      const label = h(doc, 'span', '', providerName(provider));
      const name = h(doc, 'span', 'sbs-label', '');
      name.append(label, ' ', pill);
      const help = info.action === 'install' ? (helpOpen[provider] ? info.note || 'Install it, then come back here.' : '') : info.note;
      const r = row('', '', []);
      const text = /** @type {HTMLElement} */ (r.firstElementChild);
      text.replaceChildren(name);
      if (help) text.append(h(doc, 'span', 'sbs-help', help));
      const ctl = /** @type {HTMLElement} */ (r.lastElementChild);
      if (info.action === 'signIn') ctl.append(textButton(doc, 'Sign in', 'sbm-link', () => act(async () => {
        const result = await s.signIn(provider);
        if (result?.openUrl) host.openLink(result.openUrl, { outside: true });
        await result?.done?.catch(() => null);
        await s.load();
      })));
      else if (info.action === 'install') ctl.append(textButton(doc, helpOpen[provider] ? 'Hide' : 'How to install', 'sbm-link', () => { helpOpen[provider] = !helpOpen[provider]; paint(); }));
      else if (info.action === 'retry') ctl.append(textButton(doc, 'Try again', 'sbm-link', () => act(() => s.load())));
      if (provider.startsWith('oss:')) ctl.append(textButton(doc, 'Remove', 'sbm-link is-quiet', () => act(() => s.removeEndpoint(provider.slice(4)))));
      r.dataset.provider = provider;
      g.append(r);
      if (info.ok) g.append(modelList(state, provider));
    }
    const other = row('Other services', 'OpenRouter, LM Studio or any OpenAI-compatible address and key.', [textButton(doc, '+ Add', 'sbm-link', () => openDrawer())]);
    other.dataset.row = 'other-services';
    g.append(other);
    return g;
  };

  const paintMac = (/** @type {import("./models-data.js").ModelsState} */ state) => {
    const g = group('On this Mac');
    const local = statusOf(state, 'local');
    const name = h(doc, 'span', 'sbs-label', 'Models on this Mac ');
    if (local) name.append(h(doc, 'span', `sbm-pill${local.state === 'ready' ? '' : ' is-off'}`, local.state === 'ready' ? 'Ready' : local.state === 'missing' ? 'Not set up' : 'Not ready'));
    const r = row('', '', [textButton(doc, 'Open ›', 'sbm-link', () => ctx.select?.('mac'))]);
    /** @type {HTMLElement} */ (r.firstElementChild).replaceChildren(name, h(doc, 'span', 'sbs-help', `${local?.detail ? `${local.detail} ` : ''}Folders, idle time and reports are in On this Mac.`.trim()));
    g.append(r);
    return g;
  };

  // --------------------------------------------------------------------------------- the "add a service" drawer

  const closeDrawer = () => { drawer?.remove(); drawer = null; };

  const openDrawer = () => {
    closeDrawer();
    const s = /** @type {ModelsStore} */ (store);
    const backdrop = h(doc, 'div', 'sbm-backdrop');
    const panel = h(doc, 'aside', 'sbm-drawer');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Add a service');
    let created = '';
    /** @type {{ id: string, label: string }[]} */
    let found = [];
    const ticked = new Set();

    const field = (/** @type {string} */ label, /** @type {string} */ type, /** @type {string} */ placeholder) => {
      const wrap = h(doc, 'label', 'sbm-field');
      wrap.append(h(doc, 'span', 'sbs-label', label));
      const input = /** @type {HTMLInputElement} */ (h(doc, 'input', 'sbs-input sbm-input'));
      input.type = type;
      input.placeholder = placeholder;
      input.autocomplete = 'off';
      input.setAttribute('aria-label', label);
      wrap.append(input);
      return { wrap, input };
    };
    const name = field('Name', 'text', 'OpenRouter');
    const address = field('Address', 'text', 'https://openrouter.ai/api/v1');
    address.wrap.append(h(doc, 'span', 'sbs-help', 'Include http:// or https://'));
    const key = field('Key', 'password', 'Leave empty for a server on this Mac');
    const reveal = textButton(doc, 'Show', 'sbm-link sbm-reveal', () => {
      const show = key.input.type === 'password';
      key.input.type = show ? 'text' : 'password';
      reveal.textContent = show ? 'Hide' : 'Show';
    });
    key.wrap.append(reveal);

    const note = h(doc, 'p', 'sbs-note sbm-drawer-note');
    note.setAttribute('role', 'status');
    const listBox = h(doc, 'div', 'sbm-found');
    const paintFound = () => {
      listBox.replaceChildren();
      for (const m of found) {
        const label = /** @type {HTMLLabelElement} */ (h(doc, 'label', 'sbm-model'));
        const check = /** @type {HTMLInputElement} */ (h(doc, 'input'));
        check.type = 'checkbox';
        check.checked = ticked.has(m.id);
        check.addEventListener('change', () => { if (check.checked) ticked.add(m.id); else ticked.delete(m.id); });
        label.append(check, h(doc, 'span', 'sbm-model-name', m.label));
        listBox.append(label);
      }
    };

    const draft = () => ({ name: name.input.value, baseUrl: normalizeAddress(address.input.value), key: key.input.value || null });
    const problem = () => endpointProblem(draft(), (s.state.settings.endpoints ?? []).map((e) => e.name).filter((n) => n !== created));

    const fetchBtn = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sb-button', 'Fetch models'));
    fetchBtn.type = 'button';
    fetchBtn.addEventListener('click', async () => {
      const bad = problem();
      if (bad) { note.textContent = bad; return; }
      fetchBtn.disabled = true;
      note.textContent = '';
      try {
        const d = draft();
        const saved = await s.saveEndpoint(d);
        created = saved.name;
        const list = await s.fetchEndpointModels(saved.name);
        found = list.map((m) => ({ id: m.id, label: m.label }));
        if (!found.length) note.textContent = 'It answered, but listed no models. You can add a model ID after saving.';
        paintFound();
      } catch (error) {
        host.logError?.(error);
        note.textContent = "Couldn't get the model list. Check the address and key.";
      }
      fetchBtn.disabled = false;
    });

    const save = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sb-button is-primary', 'Save'));
    save.type = 'button';
    save.addEventListener('click', async () => {
      const bad = problem();
      if (bad) { note.textContent = bad; return; }
      save.disabled = true;
      try {
        const saved = await s.saveEndpoint(draft());
        if (created && created !== saved.name) await s.removeEndpoint(created);
        const provider = `oss:${saved.name}`;
        const shown = [...(s.state.settings.shownModels ?? []), ...[...ticked].map((id) => `${provider}:${id}`)];
        await s.write({ shownModels: shown });
        closeDrawer();
        created = '';
        paint();
      } catch (error) { say(error); save.disabled = false; }
    });
    const cancel = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sb-button', 'Cancel'));
    cancel.type = 'button';
    cancel.addEventListener('click', async () => {
      // Fetch models saves the service so the engine can ask it; cancelling takes it back out
      if (created) { try { await s.removeEndpoint(created); } catch (error) { say(error); } }
      closeDrawer();
      paint();
    });
    backdrop.addEventListener('click', () => cancel.click());

    const head = h(doc, 'div', 'sbm-drawer-head');
    head.append(h(doc, 'h3', 'sbm-drawer-title', 'Add a service'));
    const modelsHead = h(doc, 'div', 'sbm-drawer-models');
    modelsHead.append(h(doc, 'span', 'sbs-label', 'Models'), fetchBtn);
    const foot = h(doc, 'div', 'sbm-drawer-foot');
    foot.append(cancel, save);
    panel.append(head, name.wrap, address.wrap, key.wrap, modelsHead, listBox, note, foot);
    panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') cancel.click(); });
    drawer = h(doc, 'div', 'sbm-overlay');
    drawer.append(backdrop, panel);
    root.append(drawer);
    queueMicrotask(() => name.input.focus());
  };

  // ----------------------------------------------------------------------------------------------------- paint

  const paint = () => {
    const keep = drawer;
    root.replaceChildren();
    if (!store) return;
    const state = store.state;
    root.append(paintDefaults(state), paintCloud(state), paintMac(state), h(doc, 'p', 'sbm-foot', 'Ticked models show in the Answer with menu under Cloud.'));
    if (keep) root.append(keep);
  };

  void (async () => {
    root.append(h(doc, 'p', 'sbs-help', 'Loading models…'));
    try {
      store = new ModelsStore(await host.ai());
      await store.load();
      paint();
    } catch (error) {
      host.logError?.(error);
      root.replaceChildren(h(doc, 'p', 'sbs-help', "Couldn't reach the Second Brain server, so the model list isn't available."));
    }
  })();

  return root;
}
