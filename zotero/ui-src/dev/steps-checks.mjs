// ui-src/dev/steps-checks.mjs. Playwright checks for spec 007 E6 (grouped mode menu, "+ Add step" per result kind, the "On: ..."
// chip, the empty state's session cards, history rows, the Selected papers picker and its recorded `import` put, an old saved
// search importing once), run by dev/run.mjs against dev/harness/steps.html on the fake host. Screenshots go to dev/out/.
import { join } from 'node:path';

const SELECTED_LABEL = 'Foraging Strategies of the Lesser Spangled Vole and 1 more';

/** @param {import("playwright").Browser} browser @param {number} port @param {string} outDir */
export async function runStepsChecks(browser, port, outDir) {
  let failures = 0;
  let count = 0;
  const check = (name, ok, detail) => {
    count += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'} steps: ${name}${ok ? '' : ` :: ${JSON.stringify(detail)}`}`);
    if (!ok) failures += 1;
  };
  const url = (query) => `http://127.0.0.1:${port}/dev/harness/steps.html?${new URLSearchParams(query)}`;
  async function open(query, viewport = { width: 1000, height: 800 }, colorScheme = 'light') {
    const page = await browser.newPage({ viewport, colorScheme });
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
    await page.goto(url(query));
    await page.waitForFunction(() => window.__sbHarnessReady === true, null, { timeout: 8000 });
    page.errors = errors;
    return page;
  }
  const wait = (page, ms = 80) => page.waitForTimeout(ms);
  const texts = (page, selector) => page.locator(selector).allTextContents().then((all) => all.map((t) => t.trim()));
  /** Opens "+ Add step" and returns the item labels. */
  async function addStepLabels(page) {
    await page.locator('.sb-addstep-btn').click();
    await page.waitForSelector('.sb-addstep-menu .sb-art-item');
    const box = await page.locator('.sb-addstep-menu').boundingBox();
    const items = await page.locator('.sb-addstep-menu .sb-art-item').count();
    if (box.height < items * 24) throw new Error(`the Add step menu is squashed: ${box.height}px for ${items} items`);
    return texts(page, '.sb-addstep-menu .sb-art-item-label');
  }
  const noScroll = (page) => page.evaluate(() => {
    const root = document.querySelector('.sb-ai');
    return { doc: document.documentElement.scrollWidth <= document.documentElement.clientWidth, root: root.scrollWidth <= root.clientWidth,
      thread: document.querySelector('.sb-ai-thread').scrollWidth <= document.querySelector('.sb-ai-thread').clientWidth };
  });

  // ================================================================ the mode menu
  let page = await open({ tokens: 'zotero' });
  await page.evaluate(() => window.__sbS.make());
  const menu = await page.evaluate(() => {
    const pick = document.querySelector('.sb-ai-modepick');
    return {
      groups: [...pick.querySelectorAll('optgroup')].map((g) => ({ label: g.label, options: [...g.querySelectorAll('option')].map((o) => o.textContent) })),
      all: [...pick.options].map((o) => o.textContent), disabled: [...pick.options].filter((o) => o.disabled).length, hidden: [...pick.options].filter((o) => o.hidden).length,
      value: pick.value,
    };
  });
  check('mode menu: Workflows (Chat, Research report, Systematic review, Routines) and Tools (Find papers, Chat with papers, Extract data, Quick answer)',
    JSON.stringify(menu.groups) === JSON.stringify([{ label: 'Workflows', options: ['Chat', 'Research report', 'Systematic review', 'Routines'] }, { label: 'Tools', options: ['Find papers', 'Chat with papers', 'Extract data', 'Quick answer'] }]), menu.groups);
  check('mode menu: Systematic review is offered (E8), and nothing is greyed or hidden', menu.all.includes('Systematic review') && menu.disabled === 0 && menu.hidden === 0 && menu.value === 'chat', menu);

  // ================================================================ the remembered mode
  const remembered = {};
  for (const saved of ['ask', 'find', 'report', 'systematic', 'papers', 'nonsense', undefined]) {
    remembered[String(saved)] = await page.evaluate(async (value) => {
      const ctx = await window.__sbS.make({ prefs: value === undefined ? {} : { chatMode: value } });
      return { mode: ctx.chat.mode, pick: ctx.chat.modePick.value };
    }, saved);
  }
  check('remembered mode: the old saved names still work, picker modes and unknown values fall back to Chat',
    ['ask', 'find', 'report', 'systematic'].every((m) => remembered[m].mode === m && remembered[m].pick === m)
    && ['papers', 'nonsense', 'undefined'].every((m) => remembered[m].mode === 'chat'), remembered);
  // a chosen mode is remembered for the next start
  const kept = await page.evaluate(async () => {
    const ctx = await window.__sbS.make();
    ctx.chat.modePick.value = 'find';
    ctx.chat.modePick.dispatchEvent(new Event('change'));
    return ctx.host.prefs.get('chatMode');
  });
  check('remembered mode: picking Find papers saves it', kept === 'find', kept);
  await page.close();

  // ================================================================ empty state: 0, 1 and 5 sessions
  const emptyState = async (sessions, extra = {}) => {
    const p = await open({ tokens: 'zotero' });
    const out = await p.evaluate(async ({ sessions, extra }) => {
      const ctx = await window.__sbS.make({ sessions, ...extra });
      const cards = [...document.querySelectorAll('.sb-ai-empty .sb-ai-card')];
      return {
        cards: cards.length, titles: cards.map((c) => c.querySelector('.sb-ai-card-title').textContent),
        metas: cards.map((c) => c.querySelector('.sb-ai-card-when').textContent), counts: cards.map((c) => c.querySelector('.sb-ai-card-count')?.textContent ?? null),
        icons: cards.map((c) => c.querySelector('.sb-ai-card-meta svg path').getAttribute('d')), pills: document.querySelectorAll('.sb-ai-empty .sb-ai-pill').length,
        rows: document.querySelectorAll('.sb-ai-list .sb-ai-conv').length, listEmpty: Boolean(document.querySelector('.sb-ai-list-empty')),
      };
    }, { sessions, extra });
    return { p, out };
  };
  const zero = await emptyState(0);
  check('empty state, 0 sessions: no cards, the mode text and pills as before, "Your chats and reports appear here."', zero.out.cards === 0 && zero.out.pills > 0 && zero.out.listEmpty, zero.out);
  await zero.p.close();
  const one = await emptyState(1);
  check('empty state, 1 session: one card with the title, "Research report · 4 days ago" and the artifact count 2',
    one.out.cards === 1 && one.out.titles[0] === 'Excited-state ML review' && one.out.metas[0] === 'Research report · 4 days ago' && one.out.counts[0] === '2', one.out);
  await one.p.close();
  const five = await emptyState(5, { context: [] });
  check('empty state, 5 sessions: three cards (the most recent), five history rows',
    five.out.cards === 3 && five.out.rows === 5 && five.out.titles.join('|') === 'Excited-state ML review|Vole foraging table|Which meadows have owls?', five.out);
  // Obsidian's own button style is white-space: nowrap, which the harness page does not have (user report, 2026-09-29: long
  // titles ran out of their cards and over the next one). Simulate it, give a card a very long title, and measure.
  const nowrap = await five.p.evaluate(() => {
    const style = document.createElement('style');
    style.textContent = 'button { white-space: nowrap; }';
    document.head.append(style);
    const card = document.querySelector('.sb-ai-empty .sb-ai-card');
    card.querySelector('.sb-ai-card-title').textContent = 'what are the limitations of substrate screening method in the long run for many materials';
    const cards = [...document.querySelectorAll('.sb-ai-empty .sb-ai-card')];
    return cards.map((c) => {
      const t = c.querySelector('.sb-ai-card-title');
      const cr = c.getBoundingClientRect(); const tr = t.getBoundingClientRect();
      return { ws: getComputedStyle(t).whiteSpace, inside: tr.left >= cr.left - 1 && tr.right <= cr.right + 1, fits: t.scrollWidth <= t.clientWidth + 1, width: Math.round(cr.width) };
    });
  });
  check('empty state under Obsidian\'s nowrap button style: a very long card title wraps inside its card, never spills over the next card',
    nowrap.length === 3 && nowrap.every((c) => c.ws === 'normal' && c.inside && c.fits), nowrap);
  check('empty state: each card names its session kind and skips the count when there are no artifacts', five.out.metas[0].startsWith('Research report') && five.out.metas[1].startsWith('Find papers') && five.out.metas[2].startsWith('Chat'), five.out);
  await five.p.close();
  // context suggestions (the paper being read) still show, after the cards
  const paper = { attachment: { kind: 'zoteroItem', citekey: 'bramblewood2021' }, label: 'Bramblewood et al. 2021', why: 'reading' };
  const withContext = await emptyState(2, { context: [paper] });
  check('empty state: the paper being read still gets its suggestions, after the session cards', withContext.out.cards === 2 && withContext.out.pills >= 2, withContext.out);
  await withContext.p.close();
  // clicking a card reopens that session
  page = await open({ tokens: 'zotero' });
  const reopened = await page.evaluate(async () => {
    const ctx = await window.__sbS.make({ sessions: 3 });
    document.querySelector('.sb-ai-card[data-id="old2"]').click();
    await new Promise((r) => setTimeout(r, 120));
    return { session: ctx.chat.sessionID, conversation: ctx.chat.conversationID, empty: Boolean(document.querySelector('.sb-ai-empty')), selected: document.querySelector('.sb-ai-conv.is-selected')?.dataset.id };
  });
  check('empty state: one click on a card reopens the session', reopened.session === 'old2' && reopened.conversation === 'old2' && !reopened.empty && reopened.selected === 'old2', reopened);

  // ================================================================ history rows: icon, count, running dot
  const rows = await page.evaluate(async () => {
    const ctx = await window.__sbS.make({ sessions: 5 });
    const icons = window.SecondBrainUI.ICONS;
    const out = [...document.querySelectorAll('.sb-ai-list .sb-ai-conv')].map((r) => ({
      id: r.dataset.id, cls: r.className, d: r.querySelector('svg path').getAttribute('d'), count: r.querySelector('.sb-ai-conv-count')?.textContent ?? null,
      dot: getComputedStyle(r.querySelector('.sb-ai-conv-dot')).display,
    }));
    ctx.chat.sessionID = 'old1';
    ctx.chat.running = {};
    ctx.chat.markRunning();
    const running = [...document.querySelectorAll('.sb-ai-list .sb-ai-conv')].map((r) => [r.dataset.id, r.classList.contains('is-running'), getComputedStyle(r.querySelector('.sb-ai-conv-dot')).display]);
    ctx.chat.running = null;
    ctx.chat.markRunning();
    return { out, running, icons: { report: icons.report, find: icons.find, chat: icons.chat }, afterStop: document.querySelectorAll('.sb-ai-conv.is-running').length };
  });
  const byId = Object.fromEntries(rows.out.map((r) => [r.id, r]));
  check('history: the icon follows the first step kind (report, find, chat)', byId.old1.d === rows.icons.report && byId.old2.d === rows.icons.find && byId.old3.d === rows.icons.chat, byId);
  check('history: a session with artifacts shows a small count, one with none shows nothing', byId.old1.count === '2' && byId.old2.count === '1' && byId.old3.count === '2', rows.out.map((r) => [r.id, r.count]));
  check('history: a running session shows a quiet dot; the others and a stopped one show none',
    rows.out.every((r) => r.dot === 'none') && rows.running.filter((r) => r[1]).map((r) => r[0]).join() === 'old1' && rows.running.find((r) => r[1])[2] !== 'none' && rows.afterStop === 0, rows.running);
  await page.close();

  // ================================================================ "+ Add step" per result kind
  page = await open({ tokens: 'zotero' });
  const noResult = await page.evaluate(async () => {
    const ctx = await window.__sbS.make({ sessions: 1 });
    ctx.chat.sessionID = null;
    ctx.chat.renderAddStep();
    return { button: document.querySelectorAll('.sb-addstep-btn').length, chip: !document.querySelector('.sb-ai-current').hidden };
  });
  check('no results yet: no "+ Add step" and no "On:" chip', noResult.button === 0 && !noResult.chip, noResult);
  const labelsBy = {};
  for (const kind of ['papers', 'table', 'report']) {
    await page.evaluate(async (k) => { const ctx = await window.__sbS.make(); await window.__sbS.withResults(ctx, [k]); }, kind);
    labelsBy[kind] = await addStepLabels(page);
    await page.keyboard.press('Escape');
  }
  check('Add step on a paper set: Add columns, Keep filtered rows, Chat with these, Report on these', labelsBy.papers.join('|') === 'Add columns|Keep filtered rows|Chat with these|Report on these', labelsBy);
  check('Add step on a table: Chat about this table, Write a report from this', labelsBy.table.join('|') === 'Chat about this table|Write a report from this', labelsBy);
  check('Add step on a report: Chat about this report', labelsBy.report.join('|') === 'Chat about this report', labelsBy);
  check('steps that are not built yet are never shown', ![...labelsBy.papers, ...labelsBy.table, ...labelsBy.report].some((l) => /Screen|more like/.test(l)), labelsBy);
  // two results: the menu follows the current result (the newest), then the one picked with Use for next step
  await page.evaluate(async () => { const ctx = await window.__sbS.make(); window.__ctx = ctx; await window.__sbS.withResults(ctx, ['papers', 'table']); });
  const twoNewest = await addStepLabels(page);
  await page.keyboard.press('Escape');
  check('two results: the menu and chip follow the newest result (the table)', twoNewest.join('|') === 'Chat about this table|Write a report from this' && (await texts(page, '.sb-ai-on .sb-ai-chip-label'))[0] === 'On: Vole models V1', twoNewest);
  check('the "+ Add step" button is quiet: after the last thing in the thread, in the flow (not floating), dashed and small',
    await page.evaluate(() => {
      const btn = document.querySelector('.sb-addstep-btn');
      const wrap = btn.closest('.sb-addstep');
      return wrap === document.querySelector('.sb-ai-thread').lastElementChild && getComputedStyle(wrap).position === 'relative' && getComputedStyle(btn).position === 'static'
        && getComputedStyle(btn).borderTopStyle === 'dashed' && btn.getBoundingClientRect().height < 30;
    }), null);

  // ================================================================ the current-result chip
  await page.locator('.sb-art-card', { hasText: 'Vole foraging and hoarding' }).click();
  await page.waitForSelector('.sb-art-head-text');
  await page.locator('.sb-art-iconbtn[title="More"]').click();
  await page.locator('.sb-art-moremenu .sb-art-item', { hasText: 'Use for next step' }).click();
  await wait(page);
  const used = await page.evaluate(() => ({ chip: document.querySelector('.sb-ai-on .sb-ai-chip-label')?.textContent, currents: window.__ctx.store.currents, picked: window.__ctx.chat.pickedRef }));
  check('an artifact\'s menu has "Use for next step": it calls sessions.setCurrent and the chip follows', used.chip === 'On: Vole foraging and hoarding V1' && JSON.stringify(used.currents) === JSON.stringify([{ id: 'R1', version: 1 }]), used);
  const afterUse = await addStepLabels(page);
  await page.keyboard.press('Escape');
  check('and the Add step menu now fits that result', afterUse.join('|') === 'Add columns|Keep filtered rows|Chat with these|Report on these', afterUse);
  await page.locator('.sb-ai-on .sb-ai-chip-x').click();
  const cleared = await page.evaluate(() => ({ chip: !document.querySelector('.sb-ai-current').hidden, add: document.querySelectorAll('.sb-addstep-btn').length, current: window.__ctx.chat.currentSummary() }));
  check('the chip\'s x clears it: the next step starts fresh (no chip, no Add step on a result)', !cleared.chip && cleared.add === 0 && cleared.current === null, cleared);
  await page.close();

  // ================================================================ picking a step
  page = await open({ tokens: 'zotero', w: '1100' }, { width: 1132, height: 800 });
  const start = async (kinds) => { await page.evaluate(async (k) => { const ctx = await window.__sbS.make(); window.__ctx = ctx; await window.__sbS.withResults(ctx, k); }, kinds); };
  await start(['papers']);
  await addStepLabels(page);
  await page.locator('.sb-addstep-menu .sb-art-item', { hasText: 'Chat with these' }).click();
  await page.waitForSelector('.sb-pc');
  check('Chat with these opens the panel on its Chat with papers tab', (await texts(page, '.sb-art-tab.is-on')).join() === 'Chat with papers' && (await page.locator('.sb-pc-input:visible').count()) === 1, await texts(page, '.sb-art-tab'));
  await start(['papers']);
  await addStepLabels(page);
  await page.locator('.sb-addstep-menu .sb-art-item', { hasText: 'Add columns' }).click();
  await page.waitForSelector('.sb-col-pop');
  check('Add columns opens the panel with the Columns popover', (await page.locator('.sb-col-pop').count()) === 1, null);
  await start(['papers']);
  await addStepLabels(page);
  await page.locator('.sb-addstep-menu .sb-art-item', { hasText: 'Keep filtered rows' }).click();
  await page.waitForSelector('.sb-flt-pop');
  check('Keep filtered rows opens the panel with the Filters popover (nothing is narrowed yet)', (await page.locator('.sb-flt-pop').count()) === 1, null);
  await start(['table']);
  await addStepLabels(page);
  await page.locator('.sb-addstep-menu .sb-art-item', { hasText: 'Chat about this table' }).click();
  await wait(page);
  const aboutTable = await page.evaluate(() => ({ mode: window.__ctx.chat.mode, placeholder: window.__ctx.chat.input.placeholder, focus: document.activeElement === window.__ctx.chat.input, currents: window.__ctx.store.currents }));
  check('Chat about this table: a plain chat turn (composer in Chat, "Ask about this table…", current result recorded)',
    aboutTable.mode === 'chat' && aboutTable.placeholder === 'Ask about this table…' && aboutTable.focus && aboutTable.currents.length === 1, aboutTable);
  // spec 007 E7: a paper set or a table starts a Research report from the session
  const reviewOf = () => page.evaluate(() => ({ req: window.__ctx.calls.find((c) => c.kind === 'review')?.req, mode: window.__ctx.chat.mode, reportOpen: Boolean(document.querySelector('.sb-ai-thread .sb-rp')) }));
  await start(['papers']);
  await addStepLabels(page);
  await page.locator('.sb-addstep-menu .sb-art-item', { hasText: 'Report on these' }).click();
  await wait(page, 200);
  const onPapers = await reviewOf();
  check('Report on these: a pipeline-2 review on this session and paper set (it still asks and plans), and the report opens in the thread',
    onPapers.req?.pipeline === 2 && onPapers.req.session === 'sessX' && onPapers.req.on?.id === 'R1' && !onPapers.req.fromTable && !onPapers.req.autoApprove && onPapers.mode === 'report' && onPapers.reportOpen, onPapers);
  await start(['table']);
  await addStepLabels(page);
  await page.locator('.sb-addstep-menu .sb-art-item', { hasText: 'Write a report from this' }).click();
  await wait(page, 200);
  const onTable = await reviewOf();
  check('Write a report from this: the review starts at the writer (fromTable, nothing to wait for) on that table',
    onTable.req?.pipeline === 2 && onTable.req.fromTable === true && onTable.req.autoApprove === true && onTable.req.on?.id === 'R2' && onTable.req.question === 'Vole models', onTable);
  await page.close();

  // ================================================================ the picker (Selected papers) and the import put
  const selected = [
    { attachment: { kind: 'zoteroItem', citekey: 'bramblewood2021' }, label: 'Foraging Strategies of the Lesser Spangled Vole', why: 'selected' },
    { attachment: { kind: 'zoteroItem', citekey: 'hoarding2018' }, label: 'Voles, Squirrels and Other Hoarders', why: 'selected' },
  ];
  page = await open({ tokens: 'zotero', w: '1100' }, { width: 1132, height: 800 });
  const picked = await page.evaluate(async (sel) => {
    const ctx = await window.__sbS.make({ context: sel, searches: [window.__sbS.savedSearch('find-old', 'vole foraging')],
      library: (q) => window.__sbS.ROWS.filter((r) => r.ref.kind === 'paper' && r.title.startsWith(q.slice(0, 12))).map((r) => ({ ref: r.ref, title: r.title, authors: r.authors, year: r.year, venue: r.venue, doi: r.doi, abstract: r.abstract, key: 'K', fullText: r.fullText })) });
    window.__ctx = ctx;
    ctx.chat.modePick.value = 'papers';
    ctx.chat.modePick.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 150));
    return {
      rows: [...document.querySelectorAll('.sb-ai-pick-row')].map((r) => r.querySelector('.sb-ai-pick-label').textContent), mode: ctx.chat.mode, title: document.querySelector('.sb-ai-pick .sb-ai-empty-title').textContent,
      addStep: document.querySelectorAll('.sb-addstep-btn').length, stored: ctx.host.prefs.get('chatMode') ?? null,
    };
  }, selected);
  check('Chat with papers with no paper set: a picker (Selected papers, a collection, a tag, a saved search); no Add step; the mode is not remembered',
    picked.rows.join('|') === 'Selected papers|A collection|A tag|vole foraging' && picked.mode === 'papers' && picked.title === 'Chat with papers' && picked.addStep === 0 && picked.stored !== 'papers', picked);
  await page.screenshot({ path: join(outDir, 'steps-picker-zotero-light.png') });
  await page.locator('.sb-ai-pick-row', { hasText: 'Selected papers' }).click();
  await page.waitForSelector('.sb-pc');
  await wait(page, 150);
  const put = await page.evaluate(() => ({ puts: window.__ctx.store.puts.map((p) => ({ input: p.input, rows: p.draft.rows.map((r) => r.id), kind: p.draft.kind, title: p.draft.title })), tabs: [...document.querySelectorAll('.sb-art-tab.is-on')].map((t) => t.textContent),
    convs: window.__ctx.store.conversations.map((c) => [c.id, c.title, c.artifacts]), mode: window.__ctx.chat.mode, header: document.querySelector('.sb-art-head-text')?.textContent }));
  check('Selected papers records one import step: from "selection", the two papers as rows, labelled after the first paper ("<first> and 1 more")',
    put.puts.length === 1 && JSON.stringify(put.puts[0].input) === JSON.stringify({ kind: 'import', from: 'selection', label: SELECTED_LABEL }) && put.puts[0].kind === 'papers'
    && put.puts[0].rows.join() === 'p:bramblewood2021,p:hoarding2018', put);
  check('and opens that set with the Chat with papers tab, in a session of its own, the composer back in Chat',
    put.tabs.join() === 'Chat with papers' && put.convs.length === 1 && put.convs[0][2] === 1 && put.mode === 'chat' && put.header === SELECTED_LABEL, put);
  await page.close();

  // Extract data starts the same way and lands on the Columns popover; a session that has a set skips the picker
  page = await open({ tokens: 'zotero', w: '1100' }, { width: 1132, height: 800 });
  await page.evaluate(async (sel) => {
    const ctx = await window.__sbS.make({ context: sel });
    window.__ctx = ctx;
    ctx.chat.modePick.value = 'extract';
    ctx.chat.modePick.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 120));
  }, selected);
  await page.locator('.sb-ai-pick-row', { hasText: 'Selected papers' }).click();
  await page.waitForSelector('.sb-col-pop');
  check('Extract data from Selected papers opens the set with the Columns popover', (await page.locator('.sb-col-pop').count()) === 1 && (await page.evaluate(() => window.__ctx.store.puts[0].input.from)) === 'selection', null);
  await page.evaluate(async () => {
    window.__ctx.chat.modePick.value = 'papers';
    window.__ctx.chat.modePick.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 120));
  });
  check('with a paper set already in the session, Chat with papers opens it straight away (no picker), and the puts stay at one',
    (await page.locator('.sb-ai-pick').count()) === 0 && (await texts(page, '.sb-art-tab.is-on')).join() === 'Chat with papers' && (await page.evaluate(() => window.__ctx.store.puts.length)) === 1, null);
  await page.close();

  // Obsidian has no scopes: the picker hides them, it does not grey them
  page = await open({ tokens: 'obsidian' });
  const obs = await page.evaluate(async (sel) => {
    const ctx = await window.__sbS.make({ context: sel, kind: 'obsidian' });
    ctx.chat.modePick.value = 'extract';
    ctx.chat.modePick.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 120));
    return [...document.querySelectorAll('.sb-ai-pick-row')].map((r) => r.querySelector('.sb-ai-pick-label').textContent);
  }, selected);
  check('a host without scopes: the picker offers Selected papers only (collection and tag are hidden)', obs.join('|') === 'Selected papers', obs);
  await page.close();

  // a collection through the picker (Zotero)
  page = await open({ tokens: 'zotero', w: '1100' }, { width: 1132, height: 800 });
  const coll = await page.evaluate(async () => {
    const ctx = await window.__sbS.make({ library: (q, scope) => (scope.kind === 'collections' ? window.__sbS.ROWS.filter((r) => r.ref.kind === 'paper').map((r) => ({ ref: r.ref, title: r.title, authors: r.authors, year: r.year, venue: r.venue, doi: r.doi, abstract: r.abstract })) : []) });
    window.__ctx = ctx;
    ctx.chat.modePick.value = 'papers';
    ctx.chat.modePick.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 120));
    return [...document.querySelectorAll('.sb-ai-pick-row')].map((r) => r.querySelector('.sb-ai-pick-label').textContent);
  });
  check('nothing selected: Selected papers is hidden, the collection and tag rows remain', coll.join('|') === 'A collection|A tag', coll);
  await page.locator('.sb-ai-pick-row', { hasText: 'A collection' }).click();
  await page.waitForSelector('.sb-ai-pick-detail .sb-ct-row, .sb-ai-pick-detail input[type="checkbox"]');
  await page.locator('.sb-ai-pick-detail input[type="checkbox"]').first().check();
  await page.locator('.sb-ai-pick-detail .sb-button', { hasText: 'Use these papers' }).click();
  await page.waitForSelector('.sb-pc');
  const collPut = await page.evaluate(() => window.__ctx.store.puts.map((p) => [p.input, p.draft.rows.length]));
  check('a collection becomes an import from "selection" with its papers, labelled with the collection name', collPut.length === 1 && collPut[0][0].from === 'selection' && collPut[0][0].label === 'Doorknob Design' && collPut[0][1] === 2, collPut);
  await page.close();

  // ================================================================ saved Find searches: imported once
  page = await open({ tokens: 'zotero', w: '1100' }, { width: 1132, height: 800 });
  const before = await page.evaluate(async () => {
    const ctx = await window.__sbS.make({ searches: [window.__sbS.savedSearch('find-old', 'vole foraging'), window.__sbS.savedSearch('find-new', 'owl migration', 'sessOwl')] });
    window.__ctx = ctx;
    ctx.store.conversations.push({ id: 'sessOwl', mode: 'chat', title: 'owl migration', updated: new Date().toISOString(), artifacts: 1, kind: 'find' });
    ctx.chat.refreshList();
    await new Promise((r) => setTimeout(r, 120));
    return [...document.querySelectorAll('.sb-ai-list .sb-ai-conv')].map((r) => [r.dataset.id, r.className.replace('sb-ai-conv ', ''), r.querySelector('.sb-ai-conv-title').textContent]);
  });
  check('history before: the old search (no session) is listed as a saved search; a search that carries a session is listed once (its row, backed by the session)',
    before.length === 2 && before.some((r) => r[0] === 'find-old' && r[1].includes('is-find')) && before.some((r) => r[0] === 'find-new' && r[1].includes('is-find') && r[2] === 'owl migration'), before);
  await page.locator('.sb-ai-conv[data-id="find-old"]').click();
  await page.waitForSelector('.sb-fp-row');
  const opened = await page.evaluate(() => ({ rows: document.querySelectorAll('.sb-fp-row').length, add: document.querySelectorAll('.sb-addstep-btn').length, puts: window.__ctx.store.puts.length, sessions: window.__ctx.store.conversations.length }));
  check('an old saved search opens as before (its table), offers Add step, and has not been imported by looking at it', opened.rows === 4 && opened.add === 1 && opened.puts === 0 && opened.sessions === 1, opened);
  await addStepLabels(page);
  await page.locator('.sb-addstep-menu .sb-art-item', { hasText: 'Chat with these' }).click();
  await page.waitForSelector('.sb-pc');
  await wait(page, 200);
  const after = await page.evaluate(async () => {
    const saved = JSON.parse(await window.__ctx.host.files.read('searches/find-old.json'));
    return {
      puts: window.__ctx.store.puts.map((p) => [p.input.kind, p.input.from, p.input.label, p.draft.rows.length]), sessions: window.__ctx.store.conversations.map((c) => c.id), savedSession: saved.session,
      list: [...document.querySelectorAll('.sb-ai-list .sb-ai-conv')].map((r) => [r.dataset.id, r.classList.contains('is-find'), r.querySelector('.sb-ai-conv-title').textContent]),
    };
  });
  check('the first step imports it once: one put {import, from "find:find-old"} with its four rows, one new session, the saved search remembers it',
    after.puts.length === 1 && after.puts[0].join('|') === 'import|find:find-old|vole foraging|4' && after.sessions.length === 2 && after.savedSession === after.sessions[1], after);
  check('afterwards the search is in the history once, as the session (not also as a saved search)',
    after.list.length === 2 && after.list.filter((r) => r[2] === 'vole foraging').length === 1 && after.list.find((r) => r[2] === 'vole foraging')[0] === 'find-old', after.list);
  await page.evaluate(() => window.__ctx.chat.newChat());
  await page.locator('.sb-ai-conv[data-id="find-old"]').click();
  await page.waitForSelector('.sb-fp-row');
  check('and that row still opens the search table', (await page.locator('.sb-fp-row').count()) === 4 && (await page.locator('.sb-addstep-btn').count()) === 1, null);
  check('no page errors in any of the above', page.errors.length === 0, page.errors);
  await page.close();

  // ================================================================ both token maps, light and dark, 360 px, DOM parity
  const trees = {};
  for (const tokens of ['zotero', 'obsidian']) {
    for (const theme of ['light', 'dark']) {
      const bare = await open({ tokens, theme, bare: '1' }, { width: 360, height: 780 }, theme);
      const state = await bare.evaluate(async (sel) => {
        const out = {};
        const ctx = await window.__sbS.make({ sessions: 5, context: sel });
        window.__ctx = ctx;
        out.empty = window.__sbS.classTree(document.querySelector('.sb-ai-thread'));
        return out;
      }, selected);
      const emptyFit = await noScroll(bare);
      await bare.screenshot({ path: join(outDir, `steps-empty-360-${tokens}-${theme}.png`) });
      await bare.evaluate(async () => { const ctx = await window.__sbS.make(); window.__ctx = ctx; await window.__sbS.withResults(ctx, ['papers', 'table']); });
      await bare.locator('.sb-addstep-btn').click();
      await bare.waitForSelector('.sb-addstep-menu');
      const menuFit = await bare.evaluate(() => { const m = document.querySelector('.sb-addstep-menu').getBoundingClientRect(); return { left: m.left >= 0, right: m.right <= window.innerWidth }; });
      const thread = await bare.evaluate(() => window.__sbS.classTree(document.querySelector('.sb-ai-thread')));
      const composerTree = await bare.evaluate(() => window.__sbS.classTree(document.querySelector('.sb-ai-box')));
      const threadFit = await noScroll(bare);
      await bare.screenshot({ path: join(outDir, `steps-addstep-360-${tokens}-${theme}.png`) });
      await bare.keyboard.press('Escape');
      await bare.evaluate(async (sel) => {
        const ctx = await window.__sbS.make({ context: sel });
        ctx.chat.modePick.value = 'papers';
        ctx.chat.modePick.dispatchEvent(new Event('change'));
        await new Promise((r) => setTimeout(r, 150));
      }, selected);
      const pickerFit = await noScroll(bare);
      const picker = await bare.evaluate(() => window.__sbS.classTree(document.querySelector('.sb-ai-thread')));
      await bare.screenshot({ path: join(outDir, `steps-picker-360-${tokens}-${theme}.png`) });
      check(`${tokens}/${theme} 360 px: empty state with three cards, "+ Add step" with its menu and chip, and the picker fit with no horizontal scroll`,
        Object.values(emptyFit).every(Boolean) && Object.values(threadFit).every(Boolean) && Object.values(pickerFit).every(Boolean) && menuFit.left && menuFit.right && bare.errors.length === 0,
        { emptyFit, threadFit, pickerFit, menuFit, errors: bare.errors });
      if (theme === 'light') trees[tokens] = { empty: state.empty, thread, composer: composerTree, picker };
      await bare.close();
    }
  }
  for (const key of ['empty', 'thread', 'composer', 'picker']) {
    check(`parity: ${key} DOM class tree is identical (Zotero token map vs. Obsidian token map)`, trees.zotero && trees.obsidian && JSON.stringify(trees.zotero[key]) === JSON.stringify(trees.obsidian[key]), null);
  }

  // ================================================================ math renders as math; messages can be copied and edited
  for (const [tokens, theme] of [['zotero', 'light'], ['zotero', 'dark'], ['obsidian', 'light'], ['obsidian', 'dark']]) {
    const page = await open({ tokens, theme }, { width: 900, height: 780 }, theme);
    const md = [
      'For 1,12-dodecanedithiol the conductance was \\(9.0 \\times 10^{-7}G_0\\), versus \\(3.3 \\times 10^{-6}G_0\\) in solution.',
      '',
      'Inline dollars $E = mc^2$ and money like $5 and $10 stay as written.',
      '',
      '$$',
      '\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}',
      '$$',
      '',
      '\\[ a^2 + b^2 = c^2 \\]',
      '',
      'Broken: \\(\\frac{1}{\\)  and `code with $x$ inside` stay safe.',
    ].join('\n');
    const out = await page.evaluate(async (text) => {
      const ctx = await window.__sbS.make();
      const turn = ctx.chat.addAnswer();
      ctx.chat.finish(turn, text, []);
      const root = turn.root;
      const maths = [...root.querySelectorAll('.sb-math')].map((n) => ({ block: n.classList.contains('sb-math-block'), raw: n.classList.contains('is-raw'), hasMath: Boolean(n.querySelector('math')), title: n.title, w: n.getBoundingClientRect().width, h: n.getBoundingClientRect().height }));
      const paras = [...root.querySelectorAll('p')].map((p) => p.textContent);
      return { maths, text: root.textContent, paras, raw: /\\\(|\\\[|\$\$/.test([...root.querySelectorAll('p')].slice(0, 1).map((p) => p.textContent).join('')), code: root.querySelector('code')?.textContent, actions: [...root.querySelectorAll('.sb-ai-msg-action')].map((b) => b.textContent) };
    }, md);
    check(`${tokens}/${theme}: \\(...\\) renders as math (the chat answer shows no raw TeX)`, out.maths.length >= 5 && out.maths[0].hasMath && out.maths[1].hasMath && !out.raw && out.maths[0].w > 20 && out.maths[0].h > 5, out.maths);
    check(`${tokens}/${theme}: $...$ renders, but "$5 and $10" stays as money`, out.maths[2].hasMath && out.maths[2].title === 'E = mc^2' && /\$5 and \$10 stay as written/.test(out.text), { m: out.maths[2], text: out.text.slice(0, 200) });
    check(`${tokens}/${theme}: $$ and \\[ ... \\] are centered blocks that hold the equation`, out.maths[3].block && out.maths[3].hasMath && out.maths[4].block && out.maths[4].hasMath, out.maths.slice(3, 5));
    check(`${tokens}/${theme}: a broken formula falls back to its source text and code spans keep their dollars`, out.maths.some((m) => m.raw || m.hasMath) && out.code === 'code with $x$ inside', { code: out.code, maths: out.maths });
    check(`${tokens}/${theme}: a finished answer has a Copy action`, out.actions.join() === 'Copy', out.actions);
    await page.screenshot({ path: join(outDir, `math-${tokens}-${theme}.png`) });

    // the user's own message: Copy and Edit
    await page.evaluate(async () => {
      window.__copied = null;
      Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async (t) => { window.__copied = t; } }, configurable: true });
      const ctx = await window.__sbS.make();
      window.__chat = ctx.chat;
      ctx.chat.addUser('What is the conductance of the SAM?\nAnd the solution one?');
    });
    const row = page.locator('.sb-ai-user').last();
    const hiddenAtRest = await row.locator('.sb-ai-msg-actions').evaluate((n) => getComputedStyle(n).opacity);
    await row.hover();
    await wait(page, 200);
    const shown = await row.locator('.sb-ai-msg-actions').evaluate((n) => getComputedStyle(n).opacity);
    await row.getByRole('button', { name: 'Copy' }).click();
    await wait(page);
    const copied = await page.evaluate(() => ({ text: window.__copied }));
    const label = await row.getByRole('button').first().textContent();
    await row.getByRole('button', { name: 'Edit' }).click();
    const edited = await page.evaluate(() => ({ value: document.querySelector('.sb-ai-input')?.value ?? document.querySelector('textarea')?.value, focused: document.activeElement?.tagName }));
    check(`${tokens}/${theme}: a user message shows Copy and Edit on hover, Copy puts the text on the clipboard, Edit puts it back in the box`,
      hiddenAtRest === '0' && shown === '1' && copied.text === 'What is the conductance of the SAM?\nAnd the solution one?' && /Copied/.test(label)
      && edited.value === 'What is the conductance of the SAM?\nAnd the solution one?' && edited.focused === 'TEXTAREA', { hiddenAtRest, shown, copied, label, edited });
    check(`${tokens}/${theme}: no page errors`, page.errors.length === 0, page.errors);
    await page.close();
  }

  // wide pictures for the eye: empty state with cards, thread with chip and Add step
  for (const [tokens, theme] of [['zotero', 'light'], ['zotero', 'dark'], ['obsidian', 'light'], ['obsidian', 'dark']]) {
    const wide = await open({ tokens, theme, w: '900' }, { width: 940, height: 780 }, theme);
    await wide.evaluate(async () => { await window.__sbS.make({ sessions: 5 }); });
    await wide.screenshot({ path: join(outDir, `steps-empty-${tokens}-${theme}.png`) });
    await wide.evaluate(async () => { const ctx = await window.__sbS.make(); window.__ctx = ctx; await window.__sbS.withResults(ctx, ['papers', 'table']); });
    await wide.locator('.sb-addstep-btn').click();
    await wide.screenshot({ path: join(outDir, `steps-thread-${tokens}-${theme}.png`) });
    check(`${tokens}/${theme} 900 px: pictures taken, no errors`, wide.errors.length === 0, wide.errors);
    await wide.close();
  }

  // spec 011 U1: the depth slider drives the stored depth and shows what it costs in model turns
  {
    const page = await open({ tokens: 'zotero' }, { width: 1000, height: 800 });
    await page.evaluate(async () => { window.__ctx = await window.__sbS.make(); });
    await page.evaluate(() => { const pick = document.querySelector('.sb-ai-modepick'); pick.value = 'report'; pick.dispatchEvent(new Event('change')); });
    await wait(page, 200);
    const read = () => page.evaluate(() => {
      const slider = document.querySelector('.sb-ai-depth');
      return { slider: slider ? { min: slider.min, max: slider.max, value: slider.value, text: slider.getAttribute('aria-valuetext') } : null,
        label: document.querySelector('.sb-ai-depth-label')?.textContent ?? null, stored: window.__ctx.chat.depth.value,
        visible: Boolean(slider && slider.offsetParent), selectShown: Boolean(window.__ctx.chat.depth.isConnected),
        button: document.querySelector('.sb-ai-options-button')?.textContent ?? '' };
    });
    const first = await read();
    check('depth: a four-stop slider (0-3) starts on Balanced, stored as "standard", with its estimate beside it',
      first.slider?.min === '0' && first.slider?.max === '3' && first.slider?.value === '2' && first.stored === 'standard' && first.label === 'Balanced · about 16-30 turns', first);
    check('depth: the old select is no longer in the page (the slider is the control)', first.selectShown === false, first);
    await page.evaluate(() => { const s = document.querySelector('.sb-ai-depth'); s.value = '3'; s.dispatchEvent(new Event('input', { bubbles: true })); });
    await wait(page, 200);
    const smart = await read();
    check('depth: the last stop is Smart, stored as "deep", priced 28-54 turns, and named on the options button',
      smart.stored === 'deep' && smart.label === 'Smart · about 28-54 turns' && smart.slider.text === 'Smart · about 28-54 turns' && smart.button.includes('Smart'), smart);
    await page.evaluate(() => { const s = document.querySelector('.sb-ai-depth'); s.value = '1'; s.dispatchEvent(new Event('input', { bubbles: true })); });
    await wait(page, 200);
    const fast = await read();
    check('depth: the second stop is Fast, stored as "quick", priced 9-17 turns', fast.stored === 'quick' && fast.label === 'Fast · about 9-17 turns', fast);
    await page.evaluate(() => { const s = document.querySelector('.sb-ai-depth'); s.value = '0'; s.dispatchEvent(new Event('input', { bubbles: true })); });
    await wait(page, 200);
    const fastest = await read();
    check('depth: the first stop is Fastest, stored as "fastest", priced 6-12 turns, named on the options button',
      fastest.stored === 'fastest' && fastest.label === 'Fastest · about 6-12 turns' && fastest.button.includes('Fastest'), fastest);
    const asked = await page.evaluate(() => window.__ctx.calls.filter((c) => c.kind === 'review-estimate').map((c) => c.req.depth));
    check('depth: each stop asked the engine for its own estimate', ['fastest', 'quick', 'standard', 'deep'].every((d) => asked.includes(d)), asked);
    check('depth: no page errors', page.errors.length === 0, page.errors);
    await page.close();
  }

  return { failures, count };
}
