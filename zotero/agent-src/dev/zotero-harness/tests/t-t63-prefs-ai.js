/* global SB, Zotero, Services */
// T6.2/T6.3, rewritten for spec 016 U5: the preferences pane is the shared SettingsView. This mounts it through the
// real preferences.js (`SecondBrainPrefs.mount`, the function the pane runs) in an off-screen element of the main
// window, against a scripted AgentService, so it never touches a real account or spawns a real MCP server. It
// checks the rows that replaced the old AI and Outside sources groupboxes (provider cards and the model list, the
// web-search default, the MCP catalog and saved-server list) and one Zotero-only row that lives in a Zotero pref.

function scriptedAgentService(state) {
  return {
    where: 'local',
    providers: {
      async status() { return state.statuses; },
      async models(provider) { return provider === 'codex' ? [{ id: 'gpt-5.5', label: 'gpt-5.5', hint: null, efforts: [], source: 'provider' }] : []; },
      async roles() { return { ...state.roles }; },
      async setRole(role, choice) { state.roles[role] = choice; state.setRoleCalls.push({ role, choice }); },
      async signIn() { throw new Error('not exercised: no real sign-in in this test'); },
      async signOut() { throw new Error('not exercised: no real sign-out in this test'); },
    },
    settings: {
      async get() { state.settingsGets++; return { ...state.settings }; },
      async update(patch) { Object.assign(state.settings, patch); state.settingsUpdates.push(patch); return { ...state.settings }; },
    },
    mcp: {
      async list() { return state.mcp.map((config) => ({ config, state: config.enabled ? 'connected' : 'disabled', error: null, tools: config.__tools ?? [] })); },
      async save(config) {
        state.saveCalls.push(config);
        const i = state.mcp.findIndex((c) => c.name === config.name);
        const withTools = { ...config, __tools: config.name === 'pubmed' ? [{ name: 'search_pubmed', description: 'x', verdict: 'exposed' }, { name: 'delete_all', description: 'y', verdict: 'hidden_writes' }] : [] };
        if (i >= 0) state.mcp[i] = withTools; else state.mcp.push(withTools);
        return { config: withTools, state: 'connected', error: null, tools: withTools.__tools };
      },
      async remove(name) { state.mcp = state.mcp.filter((c) => c.name !== name); },
    },
  };
}

async function run(t) {
  await t.waitFor(() => SB.checkedOnce, 'the first server check');
  const win = Zotero.getMainWindow();
  const doc = win.document;

  const state = {
    statuses: [
      { provider: 'codex', state: 'ready', version: '0.155.0-alpha.16', account: { kind: 'chatgpt', label: null, plan: null }, usage: null, installHelp: null },
      { provider: 'claude', state: 'signed_out', version: null, account: { kind: 'none', label: null, plan: null }, usage: null, installHelp: 'Sign in with `claude` then `/login`, or set ANTHROPIC_API_KEY.' },
    ],
    roles: { chat: { provider: 'codex', model: null }, ask: { provider: 'codex', model: null }, lead: { provider: 'codex', model: null }, researcher: { provider: 'codex', model: null }, writer: { provider: 'codex', model: null } },
    setRoleCalls: [],
    settings: { roles: {}, endpoints: [], webSearchDefault: 'off', mcp: [], shownModels: [], addedModels: [], defaultModel: null },
    settingsGets: 0,
    settingsUpdates: [],
    mcp: [],
    saveCalls: [],
  };
  const fakeAi = scriptedAgentService(state);

  const mount = doc.createElementNS('http://www.w3.org/1999/xhtml', 'div');
  mount.style.cssText = 'position:fixed; top:-9999px; left:-9999px; width:900px;'; // off-screen, never shown to the user
  doc.documentElement.append(mount);

  // preferences.js is only ever loaded into the prefpane's own scope (its `scripts:` entry on
  // Zotero.PreferencePanes.register), not into this main-window scope bootstrap.js populates -- so it's loaded
  // here the same way the harness runner loads a test script, into a scope carrying `document` for its
  // self-init IIFE (harmless: it looks for #second-brain-prefs, which this synthetic host doesn't have, and
  // just polls quietly in the background) plus the globals its own top of file expects.
  const prefsScope = { Zotero, Services, IOUtils, PathUtils, ChromeUtils, document: doc, window: win };
  Services.scriptloader.loadSubScript('chrome://second-brain/content/preferences.js?' + Date.now(), prefsScope);
  const SecondBrainPrefs = prefsScope.SecondBrainPrefs;
  await t.check(typeof SecondBrainPrefs?.mount === 'function', 'preferences.js loads and exposes SecondBrainPrefs.mount');
  await t.check(typeof SecondBrainPrefs.initAi === 'undefined', 'the old hand-built AI pane code is gone');

  const emailPref = 'extensions.secondbrain.email';
  const emailBefore = Zotero.Prefs.get(emailPref, true);
  const realAi = SB.ai;
  SB.ai = async () => fakeAi;
  try {
    const view = SecondBrainPrefs.mount(doc, mount, SB);
    await t.check(!!view && typeof view.select === 'function', 'mount returns the SettingsView');
    await t.waitFor(() => state.settingsGets >= 1, 'the engine settings to be read');

    const sections = [...mount.querySelectorAll('.sbs-nav-item')].map((b) => b.dataset.section);
    for (const id of ['general', 'models', 'research', 'papers', 'sources', 'index', 'server', 'about']) await t.check(sections.includes(id), `the Zotero pane lists ${id}`, sections);
    await t.check(!mount.querySelector('[data-row="general.openLinks"]'), 'Zotero shows no Open links row (no browser inside Zotero)');

    // ---- Models: the cloud provider cards and their model lists (replaces the old provider rows and role pickers)
    view.select('models');
    await t.waitFor(() => mount.querySelector('[data-provider="codex"]') && mount.querySelector('[data-provider="claude"]'), 'a card per cloud provider');
    const codexCard = mount.querySelector('[data-provider="codex"]');
    const claudeCard = mount.querySelector('[data-provider="claude"]');
    await t.check(/Codex/.test(codexCard.textContent), 'the Codex card is named', codexCard.textContent);
    await t.check(/Sign in/.test(claudeCard.textContent), 'a signed-out provider offers Sign in', claudeCard.textContent);
    await t.check(!/Sign in/.test(codexCard.textContent), 'a ready provider does not offer Sign in', codexCard.textContent);
    const tick = await t.waitFor(() => mount.querySelector('input[data-model="codex:gpt-5.5"]'), 'the Codex model checklist');
    tick.click();
    await t.waitFor(() => state.settingsUpdates.some((u) => u.shownModels), 'settings.update with shownModels');
    await t.check(JSON.stringify(state.settingsUpdates.at(-1)) === JSON.stringify({ shownModels: ['codex:gpt-5.5'] }), 'ticking a model shows it in the Answer-with menu', state.settingsUpdates);

    // ---- Research: the web-search default (a change applies to the very next message)
    view.select('research');
    const webSelect = await t.waitFor(() => mount.querySelector('[data-row="research.web"] select'), 'the Search the web row');
    await t.check(webSelect.value === 'off', 'the web-search select starts on the current setting');
    const before = state.settingsUpdates.length;
    webSelect.value = 'live';
    webSelect.dispatchEvent(new win.Event('change'));
    await t.waitFor(() => state.settingsUpdates.length === before + 1, 'settings.update to be called');
    await t.check(JSON.stringify(state.settingsUpdates.at(-1)) === JSON.stringify({ webSearchDefault: 'live' }), 'the web-search select calls settings.update', state.settingsUpdates);

    // ---- Finding papers: a Zotero-only row is stored in a Zotero pref, not the engine
    view.select('papers');
    const email = await t.waitFor(() => mount.querySelector('[data-row="papers.email"] input'), 'the Email row');
    email.value = '  harness@example.org ';
    email.dispatchEvent(new win.Event('change'));
    await t.waitFor(() => Zotero.Prefs.get(emailPref, true) === 'harness@example.org', 'the email pref to be saved');
    await t.check(!state.settingsUpdates.some((u) => 'email' in u), 'the email never goes to the engine', state.settingsUpdates);
    await t.check(!!mount.querySelector('[data-row="papers.openalex"] .sb-openalex-key'), 'the OpenAlex key row is the shared one');

    // ---- Sources and tools: the MCP catalog and the saved-server list (replaces Outside sources)
    view.select('sources');
    await t.waitFor(() => mount.querySelector('.sbs-mcp-entry'), 'the catalog');
    const catalogRows = [...mount.querySelectorAll('.sbs-mcp-entry')];
    await t.check(catalogRows.length === (SB.mcpCatalog?.length ?? 0) && catalogRows.length > 0, 'the catalog renders one row per entry', catalogRows.length);
    const pubmedRow = catalogRows.find((r) => r.textContent.includes('PubMed'));
    await t.check(!!pubmedRow, 'the PubMed entry (criterion 5) is in the catalog list');
    const paperSearchRow = catalogRows.find((r) => r.textContent.includes('Multi-source'));
    await t.check(paperSearchRow?.textContent.includes('Google Scholar'), 'the paper-search entry shows its Google Scholar caveat', paperSearchRow?.textContent);

    pubmedRow.querySelector('button').click();
    await t.waitFor(() => state.saveCalls.length === 1, 'mcp.save to be called from the catalog Add button');
    await t.check(state.saveCalls[0].name === 'pubmed' && state.saveCalls[0].command === 'npx', 'clicking Add saves the exact catalog config', state.saveCalls[0]);
    await t.waitFor(() => mount.querySelectorAll('.sbs-mcp-item').length === 1, 'the saved-server list refreshes after Add');

    const serverBox = mount.querySelector('.sbs-mcp-item');
    await t.check(serverBox.textContent.includes('pubmed') && serverBox.textContent.includes('1 usable tool'), 'the server list shows the connected state and usable-tool count', serverBox.textContent);
    const hiddenLine = [...serverBox.querySelectorAll('.sbs-mcp-tools li')].find((li) => li.textContent.includes('delete_all'));
    await t.check(hiddenLine?.classList.contains('is-hidden') && hiddenLine.textContent.includes('can change things'), 'a write tool is listed but marked hidden, with its reason', hiddenLine?.textContent);

    const trustBox = serverBox.querySelector('.sbs-mcp-trust input');
    await t.check(trustBox && !trustBox.checked, 'Trust starts unchecked');
    trustBox.click();
    await t.waitFor(() => state.saveCalls.length === 2, 'toggling Trust calls mcp.save again');
    await t.check(state.saveCalls[1].trustUnmarked === true, 'Trust saves trustUnmarked: true', state.saveCalls[1]);
  } finally {
    SB.ai = realAi;
    if (emailBefore === undefined || emailBefore === '') Zotero.Prefs.clear(emailPref, true); else Zotero.Prefs.set(emailPref, emailBefore, true);
    mount.remove();
  }
}
