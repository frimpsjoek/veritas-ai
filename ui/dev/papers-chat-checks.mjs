// ui-src/dev/papers-chat-checks.mjs. Playwright checks for spec 007 E5 (Chat with papers: the side-panel tab, its scope line,
// the recorded `on`, answers in the tab and the thread, "Make a table from this", expand swap, "Papers | Chat" tabs when
// narrow), run by dev/run.mjs against dev/harness/artifacts.html with the fake host (dev/harness/fake-host.js records every
// send and stores the user record with its `on`). Screenshots go to dev/out/ (git-ignored). Invented papers only.
import { join } from 'node:path';

/** @param {import("playwright").Browser} browser @param {number} port @param {string} outDir */
export async function runPapersChatChecks(browser, port, outDir) {
  let failures = 0;
  let count = 0;
  const check = (name, ok, detail) => {
    count += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'} papers-chat: ${name}${ok ? '' : ` :: ${JSON.stringify(detail)}`}`);
    if (!ok) failures += 1;
  };
  const url = (query) => `http://127.0.0.1:${port}/dev/harness/artifacts.html?${new URLSearchParams(query)}`;
  async function open(query, viewport, colorScheme = 'light') {
    const page = await browser.newPage({ viewport, colorScheme });
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
    await page.goto(url(query));
    await page.waitForFunction(() => window.__sbHarnessReady === true, null, { timeout: 8000 });
    page.errors = errors;
    return page;
  }
  const texts = (page, selector) => page.locator(selector).allTextContents();
  /** Adds an invented paper set (n papers) to the fake session and opens it in the panel. */
  async function openSet(page, n, id = 'R9') {
    await page.evaluate(async ({ n, id }) => {
      const m = await import('/test/fixtures/artifacts.js');
      const { chat, store } = window.__sbA;
      const result = m.bigPapers(n, id);
      store.results[id] = [result];
      chat.noteArtifact({ ref: result.ref, kind: 'papers', title: result.title, versions: 1, rows: result.rows.length, columns: [], updated: result.created });
      await chat.openArtifact({ id });
    }, { n, id });
    await page.waitForSelector('.sb-art-table, .sb-art-cardlist');
  }
  const layout = (page) => page.evaluate(() => {
    const root = document.querySelector('.sb-ai');
    const q = (s) => document.querySelector(s);
    const shown = (s) => { const e = q(s); return Boolean(e) && !e.hidden && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0; };
    return {
      docScroll: document.documentElement.scrollWidth, docClient: document.documentElement.clientWidth, rootScroll: root.scrollWidth, rootClient: root.clientWidth,
      pcScroll: q('.sb-pc')?.scrollWidth ?? 0, pcClient: q('.sb-pc')?.clientWidth ?? 0, classes: root.className,
      mainShown: shown('.sb-ai-main'), setShown: shown('.sb-art-set'), colShown: shown('.sb-art-chatcol'), paneShown: shown('.sb-art-chatpane'), tabsShown: shown('.sb-art-tabs'),
      composer: shown('.sb-pc-input'),
    };
  });
  const sends = (page) => page.evaluate(() => window.__sbA.calls.filter((c) => c.kind === 'send').map((c) => c.input));
  const answers = (page) => page.evaluate(() => document.querySelectorAll('.sb-pc [data-state="done"]').length);
  /** Types a question in the tab and waits for the answer to land in the tab. */
  async function ask(page, text) {
    const before = await answers(page);
    await page.locator('.sb-pc-input').fill(text);
    await page.locator('.sb-pc-input').press('Enter');
    await page.waitForFunction((n) => document.querySelectorAll('.sb-pc [data-state="done"]').length > n, before, { timeout: 8000 });
  }
  const clickTab = (page, label) => page.locator('.sb-art-tab', { hasText: new RegExp(`^${label}$`) }).click();

  // ================================================================ the tab appears for paper sets only
  const page = await open({ tokens: 'zotero', w: '1100' }, { width: 1132, height: 800 });
  await page.evaluate(async () => { await window.__sbA.chat.openArtifact({ id: 'R2' }); });
  await page.waitForSelector('.sb-art-table');
  let l = await layout(page);
  check('a table (not a paper set) has no Chat with papers tab', (await page.locator('.sb-art-tab').count()) === 0 && !l.tabsShown && (await page.locator('.sb-pc:visible').count()) === 0, l);
  await page.evaluate(async () => { await window.__sbA.chat.openArtifact({ id: 'R1' }); });
  await page.waitForSelector('.sb-art-tab');
  check('a paper set has "Papers | Chat with papers" tabs, Papers showing', (await texts(page, '.sb-art-tab')).join('|') === 'Papers|Chat with papers' && (await layout(page)).setShown, await texts(page, '.sb-art-tab'));
  await page.evaluate(() => window.__sbA.chat.panel.showVersion(1));
  await page.waitForFunction(() => document.querySelector('.sb-art-version')?.textContent.trim() === 'V1');
  check('an older, read-only version hides the tab (hidden, not greyed)', (await page.locator('.sb-art-tab').count()) === 0 && !(await layout(page)).tabsShown, await layout(page));
  await page.evaluate(() => window.__sbA.chat.panel.showVersion(2));
  await page.waitForSelector('.sb-art-tab');

  // ================================================================ empty state, scope line
  await clickTab(page, 'Chat with papers');
  l = await layout(page);
  check('the Chat tab replaces the table; its composer says "Ask anything about these papers"',
    !l.setShown && l.composer && (await page.locator('.sb-pc-input').getAttribute('placeholder')) === 'Ask anything about these papers', l);
  const pills = await texts(page, '.sb-pc-pill');
  check('empty state: plain, generic suggestion pills', pills.length >= 2 && pills.length <= 3 && pills.includes('What do these papers have in common?'), pills);
  check('scope line: "All 4 papers", no toggle when nothing is narrowed', (await page.locator('.sb-pc-scope-text').textContent()) === 'All 4 papers' && (await page.locator('.sb-pc-scope-toggle:visible').count()) === 0, await page.locator('.sb-pc-scope').textContent());
  await page.screenshot({ path: join(outDir, 'papers-chat-empty.png') });

  // ================================================================ a set of 40: filtered, ticked, all
  await openSet(page, 40);
  await page.waitForSelector('.sb-art-tab');
  await clickTab(page, 'Papers');
  await page.locator('.sb-art-search-input').fill('acorns');
  const visibleIds = await page.evaluate(() => [...document.querySelectorAll('.sb-art-row')].map((r) => r.getAttribute('data-row')));
  await clickTab(page, 'Chat with papers');
  const scope1 = await page.locator('.sb-pc-scope').textContent();
  check('filtered to 8 of 40: "These 8 papers" with a quiet "All 40" toggle', scope1 === 'These 8 papers' + 'All 40' || scope1?.replace(/\s+/g, '') === 'These8papersAll40', scope1);
  await ask(page, 'What do these have in common?');
  let recorded = await sends(page);
  let last = recorded[recorded.length - 1];
  check('send: conversations.send carries `on` = { result: current ref, rows: the visible ids }',
    last.text === 'What do these have in common?' && last.on.result.id === 'R9' && last.on.result.version === 1 && Array.isArray(last.on.rows) && last.on.rows.length === 8
    && (visibleIds.length === 0 || visibleIds.join() === last.on.rows.join()), { last, visibleIds });
  const tabAnswer = await page.locator('.sb-pc .sb-ai-answer .sb-ai-md').last().textContent();
  const threadAnswers = await texts(page, '.sb-ai-thread .sb-ai-answer .sb-ai-md');
  check('the answer shows in the tab and, at the same time, in the main thread', tabAnswer?.includes('Voles leave a patch') && threadAnswers.some((t) => t.includes('Voles leave a patch')), { tabAnswer, threadAnswers });
  check('both places show what the question was about ("8 of 40 papers")', (await texts(page, '.sb-pc .sb-ai-user-on')).join() === '8 of 40 papers' && (await texts(page, '.sb-ai-thread .sb-ai-user-on')).includes('8 of 40 papers'), await texts(page, '.sb-ai-user-on'));
  check('a citation to a paper inside the set is a chip; one outside it is marked red (unresolved)',
    (await page.locator('.sb-pc .cite:not(.missing)').count()) === 1 && (await page.locator('.sb-pc .cite.missing').count()) === 1 && (await page.locator('.sb-pc .cite.missing').textContent()) === '@stranger2020', await texts(page, '.sb-pc .cite'));
  check('a quiet "Make a table from this" follows the answer', (await page.locator('.sb-pc-make').count()) === 1 && (await page.locator('.sb-pc-make').textContent()) === 'Make a table from this', await texts(page, '.sb-pc-actions'));
  await page.screenshot({ path: join(outDir, 'papers-chat-answer.png') });

  await page.locator('.sb-pc-make').click();
  await page.waitForFunction(() => document.querySelectorAll('.sb-pc [data-state="done"]').length >= 2);
  recorded = await sends(page);
  last = recorded[recorded.length - 1];
  check('"Make a table from this" asks for a table, about the same papers', /table/i.test(last.text) && last.on.rows.length === 8 && last.on.result.id === 'R9', last);

  // ticked
  await clickTab(page, 'Papers');
  await page.locator('.sb-art-search-input').fill('');
  const ticks = page.locator('tbody .sb-art-tick');
  await ticks.nth(1).check();
  await ticks.nth(4).check();
  const tickedIds = await page.evaluate(() => [...document.querySelectorAll('.sb-art-row.is-ticked')].map((r) => r.getAttribute('data-row')));
  await clickTab(page, 'Chat with papers');
  check('ticked rows win: "These 2 papers"', (await page.locator('.sb-pc-scope-text').textContent()) === 'These 2 papers', await page.locator('.sb-pc-scope').textContent());
  await ask(page, 'Which is the newest?');
  last = (await sends(page)).at(-1);
  check('send: `on.rows` is exactly the ticked ids', last.on.rows.length === 2 && last.on.rows.join() === tickedIds.join(), { last, tickedIds });
  // all
  await page.locator('.sb-pc-scope-toggle').click();
  check('the "All 40" toggle switches the line to "All 40 papers" and offers the way back', (await page.locator('.sb-pc-scope-text').textContent()) === 'All 40 papers' && (await page.locator('.sb-pc-scope-toggle').textContent()) === 'These 2', await page.locator('.sb-pc-scope').textContent());
  await ask(page, 'Summarise the whole set.');
  last = (await sends(page)).at(-1);
  check('send: `on.rows` is "all"', last.on.rows === 'all' && last.on.result.id === 'R9', last);

  // ================================================================ expand swaps: set is the main pane, chat a column
  await page.evaluate(() => window.__sbA.chat.panel.ticked.clear());
  await page.locator('.sb-art-head .sb-art-iconbtn[title="Make this bigger"]').click();
  await page.waitForFunction(() => document.querySelector('.sb-ai').classList.contains('is-art-expanded'));
  l = await layout(page);
  check('expand: the paper set is the main pane, the thread is out of the way, the chat is a column beside it',
    l.classes.includes('is-art-expanded') && !l.mainShown && l.setShown && l.colShown && !l.tabsShown && l.composer, l);
  check('expanded: the column holds the same turns as the tab', (await page.locator('.sb-art-chatcol .sb-ai-user').count()) === 4, await page.locator('.sb-art-chatcol .sb-ai-user').count());
  await page.locator('.sb-art-table tbody .sb-art-tick').nth(0).check();
  check('expanded: ticking in the table updates the column\'s scope line live', (await page.locator('.sb-art-chatcol .sb-pc-scope-text').textContent()) === 'This paper', await page.locator('.sb-art-chatcol .sb-pc-scope-text').textContent());
  await page.screenshot({ path: join(outDir, 'papers-chat-expanded.png') });
  await page.locator('.sb-art-head .sb-art-iconbtn[title="Shrink back beside the chat"]').click();
  l = await layout(page);
  check('expand again swaps back: the thread returns, the chat is a tab again', !l.classes.includes('is-art-expanded') && l.mainShown && !l.colShown && l.tabsShown, l);
  const errorsSoFar = page.errors.length;

  // ================================================================ reopening restores the tab from the records' `on`
  const total = await page.evaluate(() => window.__sbA.store.records.filter((r) => r.type === 'user' && r.on?.result?.id === 'R9').length);
  await page.evaluate(async () => { await window.__sbA.chat.openConversation('conv1'); await window.__sbA.chat.openArtifact({ id: 'R9' }); });
  await page.waitForSelector('.sb-art-tab');
  await clickTab(page, 'Chat with papers');
  const restored = await texts(page, '.sb-pc .sb-ai-user-text');
  check('reopened: the tab shows the stored questions asked about this result, in order', total === 4 && restored.length === 4 && restored[0] === 'What do these have in common?' && restored.at(-1) === 'Summarise the whole set.', { total, restored });
  check('reopened: each question keeps its recorded scope', (await texts(page, '.sb-pc .sb-ai-user-on')).join('|') === '8 of 40 papers|8 of 40 papers|2 of 40 papers|All 40 papers', await texts(page, '.sb-pc .sb-ai-user-on'));
  check('reopened: answers are restored with their citations (one red)', (await page.locator('.sb-pc .cite.missing').count()) === 4 && (await page.locator('.sb-pc-make').count()) === 1, await page.locator('.sb-pc .cite.missing').count());
  await page.evaluate(async () => { await window.__sbA.chat.openArtifact({ id: 'R1' }); });
  await page.waitForFunction(() => document.querySelector('.sb-art-head-text')?.textContent === 'Vole foraging and hoarding');
  check('another result\'s tab has none of those turns', (await page.locator('.sb-pc:visible .sb-ai-user').count()) === 0 || (await page.locator('.sb-pc-thread:not([hidden]) .sb-ai-user').count()) === 0, await page.locator('.sb-pc-thread:not([hidden]) .sb-ai-user').count());
  check('no console or page errors', page.errors.length === errorsSoFar && page.errors.length === 0, page.errors);
  await page.close();

  // ================================================================ widths
  const cover = await open({ tokens: 'zotero', w: '700' }, { width: 732, height: 760 });
  await cover.locator('.sb-art-card', { hasText: 'Papers' }).last().click();
  await cover.waitForSelector('.sb-art-tab');
  l = await layout(cover);
  check('700 px: the panel covers the thread, no expand button, tabs "Papers | Chat with papers"', l.classes.includes('is-art-cover') && (await cover.locator('.sb-art-iconbtn[title="Make this bigger"]').count()) === 0 && (await texts(cover, '.sb-art-tab')).join('|') === 'Papers|Chat with papers', l);
  await clickTab(cover, 'Chat with papers');
  await ask(cover, 'What is this about?');
  await cover.screenshot({ path: join(outDir, 'papers-chat-700.png') });
  l = await layout(cover);
  check('700 px: answer in the tab, no horizontal scroll', l.pcScroll <= l.pcClient && l.docScroll <= l.docClient, l);
  await cover.close();

  for (const [tokens, theme] of [['zotero', 'light'], ['zotero', 'dark'], ['obsidian', 'light'], ['obsidian', 'dark']]) {
    const narrow = await open({ tokens, theme, w: '', bare: '1' }, { width: 360, height: 780 }, theme);
    await narrow.locator('.sb-art-card', { hasText: 'Papers' }).last().click();
    await narrow.waitForSelector('.sb-art-tab');
    const labels = (await texts(narrow, '.sb-art-tab')).join('|');
    await clickTab(narrow, 'Chat');
    const empty = await layout(narrow);
    await narrow.screenshot({ path: join(outDir, `papers-chat-360-empty-${tokens}-${theme}.png`) });
    await ask(narrow, 'What is this about?');
    await narrow.screenshot({ path: join(outDir, `papers-chat-360-${tokens}-${theme}.png`) });
    l = await layout(narrow);
    check(`${tokens}/${theme} 360 px: two tabs "Papers | Chat", chat and answer fit with no horizontal scroll`,
      labels === 'Papers|Chat' && l.docScroll <= l.docClient && l.rootScroll <= l.rootClient && l.pcScroll <= l.pcClient && empty.pcScroll <= empty.pcClient && l.composer && narrow.errors.length === 0,
      { labels, l, empty, errors: narrow.errors });
    await clickTab(narrow, 'Papers');
    check(`${tokens}/${theme} 360 px: Papers tab shows the card list again`, (await narrow.locator('.sb-art-cardlist').count()) === 1 && !(await layout(narrow)).paneShown, await layout(narrow));
    await narrow.close();
    const wide = await open({ tokens, theme, w: '1100' }, { width: 1132, height: 800 }, theme);
    await wide.locator('.sb-art-card', { hasText: 'Papers' }).last().click();
    await wide.waitForSelector('.sb-art-tab');
    await clickTab(wide, 'Chat with papers');
    await ask(wide, 'What is this about?');
    await wide.locator('.sb-art-head .sb-art-iconbtn[title="Make this bigger"]').click();
    await wide.waitForSelector('.sb-art-chatcol .sb-pc');
    await wide.screenshot({ path: join(outDir, `papers-chat-expanded-${tokens}-${theme}.png`) });
    check(`${tokens}/${theme} 1100 px: expanded, set plus chat column, no errors`, (await layout(wide)).colShown && wide.errors.length === 0, wide.errors);
    await wide.close();
  }

  return { failures, count };
}
