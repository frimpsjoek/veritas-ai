// ui-src/dev/local-checks.mjs. Playwright checks for spec 010 L5: the "Answer with" button and menu (Cloud / On this Mac), the
// switch of the Chat and Ask roles, the plain failure when a switch is refused, models that cannot be used, and the
// "Passages used" block under a local answer. Both token maps x light / dark, widths 960 / 700 / 360, and Obsidian's
// hostile button style (white-space: nowrap, fixed 30 px height, a fill and a shadow). Runs on dev/harness/steps.html (fake host).
import { join } from 'node:path';

/** @param {import("playwright").Browser} browser @param {number} port @param {string} outDir */
export async function runLocalChecks(browser, port, outDir) {
  let failures = 0;
  let count = 0;
  const check = (name, ok, detail) => {
    count += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'} local: ${name}${ok ? '' : ` :: ${JSON.stringify(detail)}`}`);
    if (!ok) failures += 1;
  };
  // Obsidian's own rules, copied from its app.css: `button` (inline-flex, height: var(--input-height), nowrap) and the grey fill.
  const OBSIDIAN_BUTTON = 'button { display: inline-flex; align-items: center; justify-content: center; padding: 4px 12px; height: var(--input-height, 30px); white-space: nowrap; border: 0; }'
    + ' button:not(.clickable-icon) { background-color: #ddd; box-shadow: 0 1px 1px rgba(0,0,0,.3); }';
  const HOSTILE = `${OBSIDIAN_BUTTON} button { justify-content: center; white-space: nowrap; height: 30px; box-shadow: 0 1px 1px rgba(0,0,0,.3); background: #ddd; }`;
  // Worst case: a theme that pins the height with !important and a selector more specific than Obsidian's own.
  const WORST = `${HOSTILE} body button:not(.clickable-icon) { height: 30px !important; max-height: 25px !important; white-space: nowrap !important; }`;
  async function open({ tokens = 'zotero', theme = 'light', w = 960, hostile = false, worst = false } = {}) {
    const page = await browser.newPage({ viewport: { width: Math.max(w + 40, 400), height: 900 }, colorScheme: theme });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(`http://127.0.0.1:${port}/dev/harness/steps.html?${new URLSearchParams({ tokens, theme, w: String(w) })}`);
    await page.waitForFunction(() => window.__sbHarnessReady === true, null, { timeout: 8000 });
    if (hostile || worst) await page.addStyleTag({ content: worst ? WORST : HOSTILE });
    page.errors = errors;
    return page;
  }
  const popBox = (page) => page.evaluate(() => {
    const pop = document.querySelector('.sb-local-pop');
    const frame = document.getElementById('frame').getBoundingClientRect();
    if (!pop) return null;
    const r = pop.getBoundingClientRect();
    const over = [...pop.querySelectorAll('*')].filter((e) => e.getBoundingClientRect().right > r.right + 0.5).map((e) => e.className).slice(0, 4);
    return { left: r.left - frame.left, right: frame.right - r.right, top: r.top, bottom: r.bottom, height: r.height, over, scrollX: pop.scrollWidth > pop.clientWidth + 1,
      docScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth };
  });

  // ================================================================ every combination renders and fits
  for (const tokens of ['zotero', 'obsidian']) {
    for (const theme of ['light', 'dark']) {
      for (const w of [960, 700, 360]) {
        const tag = `${tokens}/${theme} @${w}`;
        const page = await open({ tokens, theme, w, hostile: tokens === 'obsidian' });
        await page.evaluate(() => window.__sbS.make({ local: true }));
        const btn = page.locator('.sb-ai-localbtn');
        const visible = await btn.isVisible();
        const text = (await btn.textContent())?.trim();
        const style = await btn.evaluate((e) => { const c = getComputedStyle(e); return { color: c.color, border: c.borderTopColor, ws: c.whiteSpace, clipped: e.scrollHeight > e.clientHeight + 1, over: e.scrollWidth > e.clientWidth + 1 }; });
        check(`${tag}: the Answer-with button shows "Cloud", tokens resolve, text is not clipped`, visible && text === 'Cloud' && style.color !== '' && style.border !== '' && !style.clipped && !style.over && style.ws === 'normal', { visible, text, style });
        await btn.click();
        await page.waitForSelector('.sb-local-pop .sb-art-item');
        const rows = await page.locator('.sb-local-pop .sb-art-item-label').allTextContents();
        const box = await popBox(page);
        check(`${tag}: the menu lists Cloud and the three models`, rows.length === 4 && rows[0] === 'Cloud' && rows[1] === 'Underdog Woof 4B 1.1', rows);
        const visibleRows = await page.locator('.sb-local-pop .sb-art-item:visible .sb-art-item-label').allTextContents();
        check(`${tag}: the untested model is folded under "More models (1)", closed`, visibleRows.length === 3 && /More models \(1\)/.test(await page.locator('.sb-local-more').innerText()) && (await page.locator('.sb-local-more').getAttribute('aria-expanded')) === 'false', visibleRows);
        check(`${tag}: the menu sits inside the pane with no sideways scroll`, box && box.left >= -0.5 && box.right >= -0.5 && box.top >= 0 && box.over.length === 0 && !box.scrollX && !box.docScroll, box);
        const wrap = await page.evaluate(() => [...document.querySelectorAll('.sb-local-pop .sb-art-item')].map((row) => {
          const label = row.querySelector('.sb-art-item-label'); const hint = row.querySelector('.sb-art-item-hint');
          return { label: label.scrollWidth <= label.clientWidth + 1, hint: !hint || hint.scrollWidth <= hint.clientWidth + 1, rowFits: row.scrollHeight <= row.clientHeight + 1 };
        }));
        check(`${tag}: long names and notes wrap instead of running off or clipping`, wrap.every((x) => x.label && x.hint && x.rowFits), wrap);
        const texts = await page.locator('.sb-local-pop').innerText();
        check(`${tag}: no "N models found" line; the short honest note is there, in plain words`, !/models found/.test(texts) && /Runs on your Mac and can get facts wrong\. Check the passages under each answer\./.test(texts) && !/mlx|server/i.test(texts), texts);
        await page.screenshot({ path: join(outDir, `local-${tokens}-${theme}-${w}.png`) });
        check(`${tag}: no page errors`, page.errors.length === 0, page.errors);
        await page.close();
      }
    }
  }

  // ================================================================ no row overlaps another; More models; the selected untested model stays visible
  const GB = 1024 ** 3;
  const mlx = (repo, label, gb, note) => ({ id: `mlx:${repo}`, label, isDefault: false, source: 'mlx', sizeBytes: gb * GB, note, unavailable: null });
  const SEVEN = [
    mlx('ConwayResearch/Underdog-Woof-4B-1.1', 'Underdog Woof 4B 1.1', 2.2, 'Best of the models tried here. Still gets some facts wrong.'),
    mlx('ConwayResearch/Underdog-Woof-2B-1.1', 'Underdog Woof 2B 1.1', 1.3, 'Often refuses or misses answers.'),
    mlx('x/gemma-4-E4B-it-MLX-4bit', 'gemma 4 E4B it MLX 4bit', 6.4, 'Not tested on your library.'),
    mlx('x/Qwen3.5-9B-MLX-4bit', 'Qwen3.5 9B MLX 4bit', 5.5, 'Not tested on your library.'),
    mlx('x/gemma-4-e2b-it-4bit', 'gemma 4 e2b it 4bit', 3.3, 'Not tested on your library.'),
    mlx('x/Qwen3.5-2B-MLX-4bit', 'Qwen3.5 2B MLX 4bit', 1.6, 'Not tested on your library.'),
    mlx('x/Qwen3.5-4B-MLX-4bit', 'Qwen3.5 4B MLX 4bit', 2.8, 'Not tested on your library.'),
  ];
  SEVEN[0].isDefault = true;
  const UNTESTED_SELECTED = 'mlx:x/Qwen3.5-4B-MLX-4bit';
  /** Every visible menu part (heads, rows, toggle, note) with its box, and every pair of them that intersect. */
  const geometry = (page) => page.evaluate(() => {
    const pop = document.querySelector('.sb-local-pop');
    const parts = [...pop.querySelectorAll(':scope > *, :scope > .sb-local-more-list > *')].filter((e) => e.getClientRects().length && !e.classList.contains('sb-local-more-list'));
    const rect = (e) => { const r = e.getBoundingClientRect(); return { top: Math.round(r.top * 10) / 10, bottom: Math.round(r.bottom * 10) / 10, height: Math.round(r.height * 10) / 10 }; };
    const boxes = parts.map((e) => ({ cls: e.className.slice(0, 24), text: e.textContent.trim().slice(0, 28), ...rect(e) }));
    const overlaps = [];
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) if (Math.min(boxes[i].bottom, boxes[j].bottom) - Math.max(boxes[i].top, boxes[j].top) > 0.5) overlaps.push([boxes[i].text, boxes[j].text]);
    const rows = parts.filter((e) => e.classList.contains('sb-art-item'));
    const clipped = rows.filter((e) => e.scrollHeight > e.clientHeight + 1 || e.querySelector('.sb-art-item-text').getBoundingClientRect().bottom > e.getBoundingClientRect().bottom + 0.5).map((e) => e.textContent.trim().slice(0, 28));
    const labels = rows.map((e) => e.querySelector('.sb-art-item-label').textContent);
    return { boxes, overlaps, clipped, labels, scrolls: pop.scrollHeight > pop.clientHeight + 1 };
  });
  const OVERLAP_VARIANTS = [['zotero', 'light', false], ['obsidian', 'dark', true], ['obsidian', 'light', true]];
  for (const [tokens, theme, obsidianHost] of OVERLAP_VARIANTS) {
    for (const w of [360, 960]) {
      for (const worst of obsidianHost ? [false, true] : [false]) {
        const tag = `${tokens}/${theme} @${w}${worst ? ' worst-case button rules' : ''}`;
        const page = await open({ tokens, theme, w, hostile: obsidianHost && !worst, worst });
        await page.evaluate((models) => window.__sbS.make({ local: { models } }), SEVEN);
        await page.locator('.sb-ai-localbtn').click();
        await page.waitForSelector('.sb-local-pop .sb-art-item');
        const closed = await geometry(page);
        check(`${tag}: closed menu, no row overlaps another and none clips its two lines`, closed.overlaps.length === 0 && closed.clipped.length === 0 && closed.labels.length === 3 && closed.labels.join('|') === 'Cloud|Underdog Woof 4B 1.1|Underdog Woof 2B 1.1', closed);
        await page.screenshot({ path: join(outDir, `local-menu-closed-${tokens}-${theme}-${w}${worst ? '-worst' : ''}.png`) });
        const heights = closed.boxes.filter((b) => /^(Cloud|Underdog)/.test(b.text)).map((b) => b.height);
        check(`${tag}: two-line rows are taller than one 30 px button (${heights.join(', ')} px)`, heights.every((x) => x > 36), heights);
        await page.locator('.sb-local-more').click();
        const open7 = await geometry(page);
        const toggleText = await page.locator('.sb-local-more').innerText();
        check(`${tag}: More models (5) opens in place: 5 more rows, none overlapping, toggle says expanded`, /More models \(5\)/.test(toggleText) && open7.labels.length === 8 && open7.overlaps.length === 0 && open7.clipped.length === 0 && (await page.locator('.sb-local-more').getAttribute('aria-expanded')) === 'true', open7);
        const inside = await popBox(page);
        check(`${tag}: the opened menu stays inside the window`, inside && inside.top >= -0.5 && inside.bottom <= 900.5 && inside.left >= -0.5 && inside.right >= -0.5, inside);
        await page.screenshot({ path: join(outDir, `local-menu-open-${tokens}-${theme}-${w}${worst ? '-worst' : ''}.png`) });
        await page.locator('.sb-local-more').click();
        const folded = await page.locator('.sb-local-pop .sb-art-item:visible').count();
        check(`${tag}: More models folds again`, folded === 3, folded);
        await page.close();
      }
    }
  }
  {
    const page = await open({ tokens: 'obsidian', theme: 'dark', w: 360, hostile: true });
    await page.evaluate(({ models, id }) => window.__sbS.make({ local: { models, roles: { chat: { provider: 'local', model: id }, ask: { provider: 'local', model: id } } } }), { models: SEVEN, id: UNTESTED_SELECTED });
    await page.locator('.sb-ai-localbtn').click();
    await page.waitForSelector('.sb-local-pop .sb-art-item');
    const g = await geometry(page);
    const ticked = await page.locator('.sb-local-pop .sb-art-item.is-selected:visible .sb-art-item-label').allTextContents();
    check('a selected model that was never tested stays in the top group, ticked, with More models (4) behind it', ticked.join() === 'Qwen3.5 4B MLX 4bit' && g.labels.includes('Qwen3.5 4B MLX 4bit') && /More models \(4\)/.test(await page.locator('.sb-local-more').innerText()) && g.overlaps.length === 0, { ticked, labels: g.labels });
    await page.screenshot({ path: join(outDir, 'local-menu-selected-untested-obsidian-dark-360.png') });
    await page.close();
  }
  // ================================================================ behaviour (Obsidian map, hostile button style, 700)
  let page = await open({ tokens: 'obsidian', w: 700, hostile: true });
  const state = await page.evaluate(async () => {
    const ctx = await window.__sbS.make({ local: true });
    const out = {};
    const btn = () => document.querySelector('.sb-ai-localbtn');
    const labelOf = () => btn().textContent.trim();
    out.start = labelOf();
    btn().click();
    await new Promise((r) => setTimeout(r, 60));
    const items = [...document.querySelectorAll('.sb-local-pop .sb-art-item')];
    out.selectedAtStart = items.filter((i) => i.classList.contains('is-selected')).map((i) => i.querySelector('.sb-art-item-label').textContent);
    items[1].click(); // Woof 4B
    await new Promise((r) => setTimeout(r, 80));
    out.afterPick = labelOf();
    out.setRoles = ctx.calls.filter((c) => c.kind === 'setRole').map((c) => [c.role, c.choice.provider, c.choice.model]);
    out.saved = ctx.host.prefs.get('cloudRoles');
    out.popClosed = !document.querySelector('.sb-local-pop');
    btn().click();
    await new Promise((r) => setTimeout(r, 60));
    out.selectedNow = [...document.querySelectorAll('.sb-local-pop .sb-art-item.is-selected .sb-art-item-label')].map((e) => e.textContent);
    [...document.querySelectorAll('.sb-local-pop .sb-art-item')][0].click(); // Cloud
    await new Promise((r) => setTimeout(r, 80));
    out.afterCloud = labelOf();
    out.restored = ctx.calls.filter((c) => c.kind === 'setRole').slice(2).map((c) => [c.role, c.choice.provider]);
    // modes: only Chat and Quick answer have the button
    out.modes = {};
    for (const mode of ['ask', 'find', 'report', 'chat']) { ctx.chat.setMode(mode); out.modes[mode] = !btn().hidden; }
    return out;
  });
  check('Answer with: starts on Cloud with Cloud ticked', state.start === 'Cloud' && state.selectedAtStart.join() === 'Cloud', state);
  check('picking Woof 4B sets Chat and Ask to that model, closes the menu, and the button names it', JSON.stringify(state.setRoles) === JSON.stringify([['chat', 'local', 'mlx:ConwayResearch/Underdog-Woof-4B-1.1'], ['ask', 'local', 'mlx:ConwayResearch/Underdog-Woof-4B-1.1']]) && state.afterPick === 'On this Mac: Underdog Woof 4B 1.1' && state.popClosed, state);
  check('the cloud choice it replaced is remembered, and the picked model is ticked next time', state.saved?.chat?.provider === 'codex' && state.saved?.ask?.provider === 'codex' && state.selectedNow.join() === 'Underdog Woof 4B 1.1', state);
  check('picking Cloud puts Chat and Ask back on what they were', state.afterCloud === 'Cloud' && JSON.stringify(state.restored) === JSON.stringify([['chat', 'codex'], ['ask', 'codex']]), state);
  check('the button shows in Chat and Quick answer only', state.modes.ask && state.modes.chat && !state.modes.find && !state.modes.report, state.modes);
  await page.close();

  // a refused switch is told plainly and changes nothing
  page = await open({ tokens: 'zotero', w: 700 });
  const refused = await page.evaluate(async () => {
    const ctx = await window.__sbS.make({ local: true });
    ctx.providers.state.refuse = 'On this Mac models only answer questions in Chat and Ask.';
    document.querySelector('.sb-ai-localbtn').click();
    await new Promise((r) => setTimeout(r, 60));
    document.querySelectorAll('.sb-local-pop .sb-art-item')[1].click();
    await new Promise((r) => setTimeout(r, 80));
    return { label: document.querySelector('.sb-ai-localbtn').textContent.trim(), notices: ctx.calls.filter((c) => c.kind === 'notice').map((c) => c.text) };
  });
  check('a refused switch shows the engine\'s plain sentence and the button stays on Cloud', refused.label === 'Cloud' && refused.notices[0] === 'On this Mac models only answer questions in Chat and Ask.', refused);
  await page.close();

  // unavailable models are listed with the reason and cannot be picked; a missing provider hides the button
  page = await open({ tokens: 'zotero', w: 700 });
  const unavailable = await page.evaluate(async () => {
    const models = [{ id: 'mlx:a/b', label: 'B', isDefault: false, source: 'mlx', sizeBytes: 3 * 1024 ** 3, note: "Needs mlx-lm, which isn't installed.", unavailable: "Needs mlx-lm, which isn't installed." }];
    const status = { provider: 'local', state: 'missing', version: null, account: { kind: 'none', label: null, plan: null }, usage: null, installHelp: 'Install it with: ~/woof-bench/.venv/bin/pip install mlx-lm', detail: "Local models need mlx-lm, which isn't installed." };
    await window.__sbS.make({ local: { models, status } });
    document.querySelector('.sb-ai-localbtn').click();
    await new Promise((r) => setTimeout(r, 60));
    const row = document.querySelectorAll('.sb-local-pop .sb-art-item')[1];
    const text = document.querySelector('.sb-local-pop').innerText;
    const none = await window.__sbS.make({ local: { status: null } });
    return { disabled: row.disabled, hint: row.querySelector('.sb-art-item-hint').textContent, text, hiddenWithout: document.querySelector('.sb-ai-localbtn').hidden };
  });
  check('a model that cannot run is listed disabled with its reason, and the fix is shown', unavailable.disabled && /3\.0 GB · Needs mlx-lm/.test(unavailable.hint) && /pip install mlx-lm/.test(unavailable.text), unavailable);
  check('with no On this Mac provider the button is hidden', unavailable.hiddenWithout === true, unavailable);
  await page.close();

  // ================================================================ passages under a local answer
  for (const [tokens, theme] of [['zotero', 'light'], ['obsidian', 'dark']]) {
    for (const w of [960, 360]) {
      const tag = `${tokens}/${theme} @${w}`;
      page = await open({ tokens, theme, w, hostile: tokens === 'obsidian' });
      const result = await page.evaluate(async () => {
        const ctx = await window.__sbS.make({ local: true });
        const chat = ctx.chat;
        const turn = chat.addAnswer();
        chat.startLive(turn);
        const long = 'Smith found a twelve percent gain in delayed recall after one night of extended sleep, measured with a word-pair task in forty-two adults. ';
        chat.handleEvent(turn, { type: 'done', notice: 'Stopped a repeating answer.', answer: { text: 'A gain [@smith2020], also [@jones2019].', citations: [{ ref: { kind: 'paper', citekey: 'smith2020' }, status: 'resolved', title: 'Smith', retrievedThisTurn: true }, { ref: { kind: 'paper', citekey: 'jones2019' }, status: 'unknown' }],
          structured: null, usage: {}, passages: [
            { ref: { kind: 'paper', citekey: 'smith2020' }, title: 'Sleep and memory consolidation in adults across several nights of controlled study', snippet: long.repeat(2) },
            { ref: { kind: 'note', path: 'personal/a-very-long-folder-name/with-another-long-name/sleep-notes.md' }, title: 'Sleep notes', snippet: 'My notes.' }] } }, { streamText: true });
        const details = turn.root.querySelector('.sb-ai-passages');
        const closed = !details.open;
        const head = details.querySelector('summary').textContent;
        details.open = true;
        await new Promise((r) => setTimeout(r, 40));
        const frame = document.getElementById('frame').getBoundingClientRect();
        const over = [...details.querySelectorAll('*')].filter((e) => e.getBoundingClientRect().right > frame.right + 0.5).map((e) => e.className);
        const missing = turn.root.querySelectorAll('.cite.missing').length;
        // reopened chat: the stored record paints the same block
        const again = chat.addAnswer();
        chat.paintRecordedAnswer(again.root.parentElement, { answer: { text: 'A gain [@smith2020].', citations: [], passages: [{ ref: { kind: 'paper', citekey: 'smith2020' }, title: 'T', snippet: 'S' }] }, activities: [] });
        const recorded = chat.thread.querySelectorAll('.sb-ai-passages').length;
        return { closed, head, items: details.querySelectorAll('.sb-ai-passage').length, over, notice: turn.notice.textContent, missing, docScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth, recorded,
          noPassagesElsewhere: !!document.querySelector('.sb-ai-passages') };
      });
      check(`${tag}: the answer shows "Passages used (2)" folded; opened, nothing runs off the pane`, result.closed && result.head === 'Passages used (2)' && result.items === 2 && result.over.length === 0 && !result.docScroll, result);
      check(`${tag}: a citation outside the passages stays red, and the guard note is shown`, result.missing === 1 && /Stopped a repeating answer\./.test(result.notice), result);
      check(`${tag}: a reopened chat paints the passages from the stored record`, result.recorded === 2, result);
      await page.screenshot({ path: join(outDir, `local-passages-${tokens}-${theme}-${w}.png`) });
      await page.close();
    }
  }
  // ================================================================ spec 016 U4: ticked cloud models in the menu, the button names the model, Set as default
  const CLAUDE = [
    { id: 'sonnet', label: 'Sonnet', hint: 'good for most questions', efforts: [], source: 'builtin', isDefault: false },
    { id: 'opus', label: 'Opus', hint: 'deep reports', efforts: [], source: 'builtin', isDefault: false },
    { id: 'haiku', label: 'Haiku', hint: 'fastest', efforts: [], source: 'builtin', isDefault: false },
  ];
  for (const [tokens, theme, w] of [['zotero', 'light', 960], ['obsidian', 'dark', 360]]) {
    const tag = `${tokens}/${theme} @${w} ticked models`;
    const page = await open({ tokens, theme, w, hostile: tokens === 'obsidian' });
    await page.evaluate(async (cloudModels) => { window.__ctx = await window.__sbS.make({ local: { shown: ['claude:sonnet', 'claude:opus'], cloudModels } }); }, { claude: CLAUDE });
    await page.locator('.sb-ai-localbtn').click();
    await page.waitForSelector('.sb-local-pop .sb-art-item');
    const heads = await page.locator('.sb-local-pop .sb-art-pop-head').allTextContents();
    const rows = await page.locator('.sb-local-pop .sb-art-item .sb-art-item-label').allTextContents();
    check(`${tag}: Cloud lists exactly the ticked models, then On this Mac`, heads.join('|') === 'Answer with|Cloud|On this Mac' && rows.slice(0, 2).join('|') === 'Sonnet|Opus' && !rows.includes('Haiku') && !rows.includes('Cloud'), { heads, rows });
    check(`${tag}: each cloud model names its provider under it`, (await page.locator('.sb-local-pop .sb-art-item', { hasText: 'Sonnet' }).locator('.sb-art-item-hint').textContent()) === 'Claude Code');
    await page.locator('.sb-local-pop .sb-art-item', { hasText: 'Opus' }).click();
    const set = await page.evaluate(() => window.__ctx.calls.filter((c) => c.kind === 'setRole').map((c) => [c.role, c.choice.provider, c.choice.model].join(':')));
    check(`${tag}: choosing a model moves Chat and Ask together`, set.join() === 'chat:claude:opus,ask:claude:opus', set);
    check(`${tag}: the button shows the model's name, not "Cloud"`, (await page.locator('.sb-ai-localbtn').textContent()).trim() === 'Opus');
    await page.locator('.sb-ai-localbtn').click();
    await page.waitForSelector('.sb-local-pop .sb-art-item');
    const checked = await page.locator('.sb-local-pop .sb-art-item.is-selected .sb-art-item-label').allTextContents();
    check(`${tag}: the current model is the one checked`, checked.join() === 'Opus', checked);
    const geo = await popBox(page);
    check(`${tag}: the menu stays inside the window, no sideways scroll`, geo && geo.left >= -0.5 && geo.right >= -0.5 && geo.over.length === 0 && !geo.scrollX && !geo.docScroll, geo);
    await page.screenshot({ path: join(outDir, `local-ticked-${tokens}-${theme}-${w}.png`) });
    await page.locator('.sb-local-default', { hasText: 'Set as default' }).click();
    const patch = await page.evaluate(() => window.__ctx.calls.filter((c) => c.kind === 'settings').map((c) => c.patch));
    check(`${tag}: Set as default writes defaultModel for what Chat uses now`, patch.length === 1 && JSON.stringify(patch[0].defaultModel) === JSON.stringify({ provider: 'claude', model: 'opus' }), patch);
    await page.locator('.sb-ai-localbtn').click();
    await page.waitForSelector('.sb-local-pop .sb-art-item');
    check(`${tag}: once it is the default the link says so`, (await page.locator('.sb-local-pop .sb-local-default').textContent()) === 'This is the default');
    check(`${tag}: no page errors`, page.errors.length === 0, page.errors);
    await page.close();
  }
  {
    const page = await open({});
    await page.evaluate(() => window.__sbS.make({ local: { shown: [] } }));
    await page.locator('.sb-ai-localbtn').click();
    await page.waitForSelector('.sb-local-pop .sb-art-item');
    const rows = await page.locator('.sb-local-pop .sb-art-item .sb-art-item-label').allTextContents();
    check('no ticked models: one Cloud row, as before', rows[0] === 'Cloud' && (await page.locator('.sb-local-pop .sb-art-pop-head').allTextContents()).join('|') === 'Answer with|On this Mac', rows);
    await page.close();
  }
  return { failures, count };
}
