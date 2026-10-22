// ui-src/dev/live-checks.mjs. Playwright checks for the live activity feed (a running turn's steps as they happen, folding
// into one summary line when it ends) and for the composer layout (send beside the message box, never on a row of its own).
// Run by dev/run.mjs against dev/harness/live.html (a ChatView on a fake host whose replies these checks feed over time) and,
// for the Chat with papers composer, dev/harness/artifacts.html. Screenshots go to dev/out/ (git-ignored). Invented content only.
import { join } from 'node:path';

const answer = (text) => ({ text, citations: [], structured: null, usage: {} });
const act = (id, phase, kind, label, extra = {}) => ({ type: 'activity', id, phase, kind, label, ...(phase === 'end' ? { ok: true } : {}), ...extra });

/** @param {import("playwright").Browser} browser @param {number} port @param {string} outDir */
export async function runLiveChecks(browser, port, outDir, only = null) {
  const want = (name) => !only || only.includes(name);
  let failures = 0;
  let count = 0;
  const check = (name, ok, detail) => {
    count += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'} live: ${name}${ok ? '' : ` :: ${JSON.stringify(detail)}`}`);
    if (!ok) failures += 1;
  };
  const live = (query) => `http://127.0.0.1:${port}/dev/harness/live.html?${new URLSearchParams(query)}`;
  async function open(url, viewport, colorScheme = 'light', reducedMotion = 'no-preference') {
    const page = await browser.newPage({ viewport, colorScheme, reducedMotion });
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
    await page.goto(url);
    await page.waitForFunction(() => window.__sbHarnessReady === true, null, { timeout: 8000 });
    page.errors = errors;
    return page;
  }
  const push = (page, n, events) => page.evaluate(([i, e]) => window.__sbL.push(i, e), [n, events]);
  /** Rows of the newest activity block: icon path, label, detail, state classes, mark. */
  const rows = (page) => page.evaluate(() => [...document.querySelectorAll('.sb-ai-activity:last-of-type .sb-ai-step')].map((r) => ({
    cls: r.className, icon: r.querySelector('.sb-ai-step-icon path')?.getAttribute('d'), label: r.querySelector('.sb-ai-step-label')?.textContent,
    detail: r.querySelector('.sb-ai-step-detail')?.textContent ?? null, check: !!r.querySelector('.sb-ai-step-check'), x: !!r.querySelector('.sb-ai-step-x'),
  })));
  const block = (page) => page.evaluate(() => {
    const a = [...document.querySelectorAll('.sb-ai-activity')].pop();
    if (!a) return null;
    const feed = a.querySelector('.sb-ai-feed');
    const fr = feed?.getBoundingClientRect();
    return { open: a.classList.contains('is-expanded'), live: a.classList.contains('is-live'), running: a.classList.contains('is-running'),
      head: a.querySelector('.sb-ai-activity-label')?.textContent, feedH: fr ? Math.round(fr.height) : 0, feedShown: !!fr && fr.height > 0,
      atEnd: feed ? feed.scrollTop + feed.clientHeight >= feed.scrollHeight - 2 : null, scrollable: feed ? feed.scrollHeight > feed.clientHeight : null,
      reasoning: a.querySelector('.sb-ai-reasoning-text')?.textContent ?? null, caption: a.querySelector('.sb-ai-reasoning-caption')?.textContent ?? null,
      chevron: !!a.querySelector('.sb-ai-activity-chevron'), threadH: document.querySelector('.sb-ai-thread')?.scrollHeight };
  });
  const noScroll = (page) => page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    return { doc: document.documentElement.scrollWidth <= document.documentElement.clientWidth, root: q('.sb-ai').scrollWidth <= q('.sb-ai').clientWidth,
      thread: q('.sb-ai-thread').scrollWidth <= q('.sb-ai-thread').clientWidth, feed: !q('.sb-ai-feed') || q('.sb-ai-feed').scrollWidth <= q('.sb-ai-feed').clientWidth };
  });

  // ================================================================ the feed, both token maps, both themes
  if (want('feed')) for (const tokens of ['zotero', 'obsidian']) {
    for (const theme of ['light', 'dark']) {
      const tag = `${tokens}-${theme}`;
      const page = await open(live({ tokens, theme, w: '560' }), { width: 600, height: 700 }, theme);
      const icons = await page.evaluate(() => Object.fromEntries(['find', 'paper', 'note', 'web', 'sparkle', 'check', 'close'].map((n) => [n, SecondBrainUI.ICONS[n]])));
      await page.evaluate(() => window.__sbL.make());
      const n = await page.evaluate(() => window.__sbL.start('Where do voles hoard seeds?'));

      await push(page, n, [{ type: 'reasoning', delta: 'Looking in the library first, then the wider literature.' }, act('s1', 'start', 'library', 'Searching your papers for "vole hoarding"')]);
      let b = await block(page); let r = await rows(page);
      check(`${tag}: while running the block is open with a live list (1 row, running, shimmer class)`, b?.open && b.live && b.running && r.length === 1 && /is-running/.test(r[0].cls), { b, r });
      check(`${tag}: reasoning streams as a grey "Thinking" caption with its text`, b?.caption === 'Thinking' && /Looking in the library/.test(b.reasoning ?? ''), b);
      check(`${tag}: a running row is present tense with an ellipsis and a search icon`, /^Searching your papers for "vole hoarding"…$/.test(r[0].label) && r[0].icon === icons.find && !r[0].check, r[0]);

      await push(page, n, [act('s1', 'end', 'library', 'Searching your papers for "vole hoarding"', { detail: '12 papers', count: 12 }),
        act('r1', 'start', 'read', 'Reading “Owl diets in winter”')]);
      r = await rows(page);
      check(`${tag}: the list grows: a finished search (past tense, detail, check) then a running read`, r.length === 2 && /^Searched your papers/.test(r[0].label) && r[0].detail === '12 papers' && r[0].check && /is-done/.test(r[0].cls) && /is-running/.test(r[1].cls), r);

      await push(page, n, [act('r1', 'end', 'read', 'Reading “Owl diets in winter”', { source: { kind: 'paper', title: 'Owl diets in winter' } }),
        act('w1', 'start', 'web', 'Reading example.org', { tool: 'WebFetch', args: { url: 'https://example.org/x' } }),
        act('w1', 'end', 'web', 'Reading example.org', { tool: 'WebFetch', args: { url: 'https://example.org/x' }, source: { kind: 'web', title: 'Vole ecology notes', host: 'example.org' } }),
        act('n1', 'start', 'read', 'Reading “Field notes”'),
        act('n1', 'end', 'read', 'Reading “Field notes”', { source: { kind: 'note', title: 'Field notes' } }),
        act('x1', 'start', 'result', 'Reading your results'),
        act('x1', 'end', 'result', 'Reading your results', { source: { kind: 'paper', title: 'Vole foraging and hoarding' } }),
        act('f1', 'start', 'scholarly', 'Searching the literature for "cache theft"'),
        act('f1', 'end', 'scholarly', 'Searching the literature for "cache theft"', { ok: false })]);
      r = await rows(page);
      const by = (re) => r.find((x) => re.test(x.label));
      check(`${tag}: icons by kind: paper, globe with host, note, sparkle for a result, magnifier for a search`,
        by(/Owl diets/)?.icon === icons.paper && by(/Vole ecology/)?.icon === icons.web && by(/Field notes/)?.icon === icons.note
        && by(/Vole foraging/)?.icon === icons.sparkle && by(/cache theft/)?.icon === icons.find, r);
      check(`${tag}: a web page row reads "Read <title>" with its host as the detail`, by(/Vole ecology/)?.label === 'Read Vole ecology notes' && by(/Vole ecology/)?.detail === 'example.org', by(/Vole ecology/));
      check(`${tag}: a failed step shows the red x and no check`, by(/cache theft/)?.x === true && by(/cache theft/)?.check === false && /is-failed/.test(by(/cache theft/).cls), by(/cache theft/));
      await page.screenshot({ path: join(outDir, `live-running-${tag}.png`) });

      // bounded height: more rows than nine, the list keeps its height and sits at the newest
      const h1 = (await block(page)).threadH;
      const many = [];
      for (let i = 0; i < 8; i++) many.push(act(`m${i}`, 'start', 'read', `Reading “Paper number ${i}”`), act(`m${i}`, 'end', 'read', `Reading “Paper number ${i}”`, { source: { kind: 'paper', title: `Paper number ${i}` } }));
      await push(page, n, many);
      b = await block(page); r = await rows(page);
      check(`${tag}: with ${r.length} rows the list is bounded (<= 198 px), scrolls, and shows the newest`, r.length > 9 && b.feedH <= 199 && b.scrollable && b.atEnd, b);
      await push(page, n, [act('m9', 'start', 'read', 'Reading “Paper number 9”'), act('m9', 'end', 'read', 'Reading “Paper number 9”', { source: { kind: 'paper', title: 'Paper number 9' } })]);
      check(`${tag}: another row does not change the thread's height`, (await block(page)).threadH === b.threadH, { before: b.threadH, after: (await block(page)).threadH, first: h1 });

      // finish: the block folds into the one summary line
      await push(page, n, [{ type: 'text', delta: 'Voles hoard seeds in autumn.' }]);
      await page.evaluate((i) => window.__sbL.push(i, [{ type: 'done', answer: { text: 'Voles hoard seeds in autumn.', citations: [], structured: null, usage: {} } }]), n);
      await page.evaluate((i) => window.__sbL.end(i), n);
      b = await block(page);
      check(`${tag}: when the turn finishes the block folds into one summary line with a chevron`, !b.open && !b.live && !b.running && b.chevron && !b.feedShown
        && /^Ran analysis · Conducted 2 searches · read 11 sources · read 1 page · 1 failed$/.test(b.head), b);
      await page.locator('.sb-ai-activity-head').last().click();
      r = await rows(page); b = await block(page);
      check(`${tag}: clicking the summary line reopens the full list, with icons, details and the reasoning`, b.open && r.length === 15 && r[0].detail === '12 papers' && /Looking in the library/.test(b.reasoning ?? '') && b.caption === 'Thought', { rows: r.length, b });
      check(`${tag}: no console errors, no horizontal scroll`, page.errors.length === 0 && Object.values(await noScroll(page)).every(Boolean), { errors: page.errors, scroll: await noScroll(page) });
      await page.screenshot({ path: join(outDir, `live-folded-open-${tag}.png`) });
      await page.locator('.sb-ai-activity-head').last().click();
      await page.screenshot({ path: join(outDir, `live-folded-${tag}.png`) });
      await page.close();
    }
  }

  // ================================================================ streamed text redraws only its growing tail
  if (want('stream')) {
    const page = await open(live({ tokens: 'zotero', w: '560' }), { width: 600, height: 700 });
    await page.evaluate(() => window.__sbL.make());
    const n = await page.evaluate(() => window.__sbL.start('stream me'));
    const text = (delta) => ({ type: 'text', delta });
    await push(page, n, [text('First paragraph, finished.\n\n'), text('Second para')]);
    await page.evaluate(() => { const md = [...document.querySelectorAll('.sb-ai-md')].pop(); window.__first = md.children[0]; window.__second = md.children[1]; window.__md = md; });
    await push(page, n, [text('graph keeps growing.\n\nThird')]);
    const kept = await page.evaluate(() => {
      const md = [...document.querySelectorAll('.sb-ai-md')].pop();
      return { sameRoot: md === window.__md, firstKept: md.children[0] === window.__first, secondKept: md.children[1] === window.__second,
        second: md.children[1]?.textContent, count: md.children.length, third: md.children[2]?.textContent };
    });
    check('streaming: the answer root and its finished paragraph keep their nodes; the growing paragraph and a new one are updated', kept.sameRoot && kept.firstKept && !kept.secondKept && kept.second === 'Second paragraph keeps growing.' && kept.count === 3 && kept.third === 'Third', kept);
    await page.evaluate((i) => window.__sbL.push(i, [{ type: 'done', answer: { text: 'First paragraph, finished.\n\nSecond paragraph keeps growing.\n\nThird', citations: [], structured: null, usage: {} } }]), n);
    await page.evaluate((i) => window.__sbL.end(i), n);
    const final = await page.evaluate(() => [...document.querySelectorAll('.sb-ai-md')].pop().children.length);
    check('streaming: the finished answer renders all three paragraphs', final === 3, final);
    check('streaming: no console errors', page.errors.length === 0, page.errors);
    await page.close();
  }

  // ================================================================ stopped, failed and a manual close
  if (want('stop')) {
    const page = await open(live({ tokens: 'zotero', w: '560' }), { width: 600, height: 700 });
    await page.evaluate(() => window.__sbL.make());
    let n = await page.evaluate(() => window.__sbL.start('stop me'));
    await push(page, n, [act('a', 'start', 'library', 'Searching your papers for "x"')]);
    await page.evaluate(() => window.__sbL.view.stop());
    await page.evaluate((i) => window.__sbL.end(i), n);
    let b = await block(page); let r = await rows(page);
    check('a stopped turn folds, and its unfinished step has no spinner dot and no check', !b.open && !b.running && /is-stopped/.test(r[0]?.cls ?? '') && !r[0].check, { b, r });
    n = await page.evaluate(() => window.__sbL.start('fail me'));
    await push(page, n, [act('b', 'start', 'library', 'Searching your papers for "y"'), act('b', 'end', 'library', 'Searching your papers for "y"', { detail: '3 papers', count: 3 }),
      { type: 'failed', error: { kind: 'provider_crashed', message: 'It stopped.' } }]);
    await page.evaluate((i) => window.__sbL.end(i), n);
    b = await block(page);
    check('a failed turn folds too', b && !b.open && !b.live, b);
    // a block the user closes while running stays closed; the list is reachable again by the chevron
    n = await page.evaluate(() => window.__sbL.start('close me'));
    await push(page, n, [act('c', 'start', 'library', 'Searching your papers for "z"')]);
    await page.locator('.sb-ai-activity-head').last().click();
    await push(page, n, [act('c', 'end', 'library', 'Searching your papers for "z"', { detail: '2 papers' }), act('d', 'start', 'read', 'Reading a source')]);
    b = await block(page);
    check('a block the user closed while running stays closed as more steps arrive', !b.open && b.running, b);
    await page.evaluate((i) => window.__sbL.push(i, [{ type: 'done', answer: { text: 'ok', citations: [], structured: null, usage: {} } }]), n);
    await page.evaluate((i) => window.__sbL.end(i), n);
    await page.close();
  }

  // ================================================================ Find papers: the same list on its summary
  if (want('find')) {
    const page = await open(live({ tokens: 'zotero', w: '560' }), { width: 600, height: 700 });
    await page.evaluate(() => window.__sbL.make());
    const n = await page.evaluate(() => window.__sbL.findSummary());
    await push(page, n, [act('f1', 'start', 'library', 'Searching your papers for "vole hoarding"')]);
    let b = await block(page);
    check('Find papers: the summary shows the live list while it runs', b?.open && b.live && b.feedShown, b);
    await push(page, n, [act('f1', 'end', 'library', 'Searching your papers for "vole hoarding"', { detail: '4 papers' }), { type: 'done', answer: { text: 'Summary.', citations: [], structured: null, usage: {} } }]);
    await page.evaluate((i) => window.__sbL.end(i), n);
    b = await block(page);
    check('Find papers: it folds into the summary line when the summary is done, and reopens on click', b && !b.open && b.chevron && /^Ran analysis · Conducted 1 search$/.test(b.head), b);
    await page.locator('.sb-fp-summary .sb-ai-activity-head').click();
    check('Find papers: the reopened list has its step', (await rows(page)).length === 1, await rows(page));
    await page.close();
  }

  // ================================================================ reopened chats
  if (want('reopen')) {
    const page = await open(live({ tokens: 'zotero', w: '560' }), { width: 600, height: 700 });
    await page.evaluate(() => window.__sbL.make());
    const entries = [
      { id: 'a1', kind: 'library', state: 'done', label: 'Searching your papers for "voles"', detail: '5 papers' },
      { id: 'a2', kind: 'read', state: 'done', label: 'Reading a source', source: { kind: 'web', title: 'Vole notes', host: 'example.org' } },
    ];
    await page.evaluate(([e, a]) => window.__sbL.reopen({ type: 'assistant', answer: a, model: { provider: 'x', model: 'y' }, activities: [], at: '', lines: [
      { id: 'line-1', icon: 'library', title: 'Ran analysis', detail: 'Conducted 1 search · read 1 page', state: 'done', items: e.map((x) => x.label), entries: e, reasoning: null }] }), [entries, answer('Done.')]);
    let b = await block(page);
    check('a reopened chat is folded to its summary line', !b.open && !b.live && b.chevron && b.head === 'Ran analysis · Conducted 1 search · read 1 page', b);
    await page.locator('.sb-ai-activity-head').last().click();
    let r = await rows(page);
    check('expanding a reopened line lists its steps from the stored entries (no animation class)', r.length === 2 && r[0].detail === '5 papers' && r[1].label === 'Read Vole notes' && r.every((x) => !/is-new/.test(x.cls)), r);
    await page.evaluate((a) => window.__sbL.reopen({ type: 'assistant', answer: a, model: { provider: 'x', model: 'y' }, activities: ['Searching your papers for "old"', 'Reading EURSWEVT'], at: '' }), answer('Old.'));
    b = await block(page);
    check('an old record with only labels still folds ("Used 2 tools")', !b.open && b.head === 'Used 2 tools', b);
    await page.locator('.sb-ai-activity-head').last().click();
    r = await rows(page);
    check('and still expands to its labels, with icons guessed from them', r.length === 2 && r[0].icon !== r[1].icon && /Searched your papers/.test(r[0].label), r);
    await page.close();
  }

  // ================================================================ motion
  if (want('motion')) for (const reduce of [false, true]) {
    const page = await open(live({ tokens: 'zotero', w: '560' }), { width: 600, height: 700 }, 'light', reduce ? 'reduce' : 'no-preference');
    await page.evaluate(() => window.__sbL.make());
    const n = await page.evaluate(() => window.__sbL.start('motion'));
    await push(page, n, [act('a', 'start', 'library', 'Searching your papers for "x"'), act('a', 'end', 'library', 'Searching your papers for "x"', { detail: '1 paper' }), act('b', 'start', 'read', 'Reading a source')]);
    const probe = await page.evaluate(() => {
      const row = document.querySelector('.sb-ai-step.is-running');
      const mark = row && getComputedStyle(row.querySelector('.sb-ai-step-mark'), '::before');
      return { rowAnim: row ? getComputedStyle(row).animationName : null, dotAnim: mark?.animationName ?? null,
        newRows: document.querySelectorAll('.sb-ai-step.is-new').length };
    });
    check(`${reduce ? 'reduced motion: no slide-in and a still dot' : 'motion allowed: new rows slide in and the dot pulses'}`,
      reduce ? probe.rowAnim === 'none' && probe.dotAnim === 'none' : probe.rowAnim === 'sb-ai-step-in' && probe.dotAnim === 'sb-ai-step-pulse', probe);
    await page.evaluate((i) => window.__sbL.end(i), n);
    await page.close();
  }

  // ================================================================ 360 px, Obsidian's button and a monospace font
  if (want('narrow')) {
    const page = await open(live({ tokens: 'obsidian', bare: '1', w: '360' }), { width: 360, height: 700 });
    await page.addStyleTag({ content: 'button { white-space: nowrap; } body, .sb-ai { font-family: monospace; font-size: 15px; }' });
    await page.evaluate(() => window.__sbL.make());
    const n = await page.evaluate(() => window.__sbL.start('narrow'));
    const long = 'a very long search phrase about the winter foraging behaviour of field voles in mixed meadows and hedgerows';
    const evs = [];
    for (let i = 0; i < 12; i++) evs.push(act(`q${i}`, 'start', 'library', `Searching your papers for "${long} ${i}"`), act(`q${i}`, 'end', 'library', `Searching your papers for "${long} ${i}"`, { detail: `${i + 10} papers`, count: i + 10 }));
    evs.push(act('w', 'start', 'read', 'Reading a page'), act('w', 'end', 'read', 'Reading a page', { source: { kind: 'web', title: 'A page with a really quite long title indeed', host: 'a-long-hostname.example.org' } }));
    await push(page, n, evs);
    const b = await block(page); const s = await noScroll(page);
    const rowH = await page.evaluate(() => [...document.querySelectorAll('.sb-ai-step')].map((r) => Math.round(r.getBoundingClientRect().height)));
    check('360 px, monospace, button nowrap: rows stay one line (22 px), the list is bounded, nothing scrolls sideways',
      rowH.every((h) => h === 22) && b.feedH <= 199 && Object.values(s).every(Boolean), { rowH: [...new Set(rowH)], feedH: b.feedH, s });
    await page.screenshot({ path: join(outDir, 'live-360-mono.png') });
    await page.evaluate((i) => window.__sbL.end(i), n);
    await page.close();
  }

  // ================================================================ the composer: send beside the message box, never on its own row
  const composerBox = (page) => page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const rect = (e) => { const r = e.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), height: Math.round(r.height), width: Math.round(r.width) }; };
    const send = q('.sb-ai-send'); const input = q('.sb-ai-input'); const row = q('.sb-ai-box > .sb-ai-row:not(.sb-ai-report-options)'); const comp = q('.sb-ai-composer'); const inputrow = q('.sb-ai-inputrow');
    return { send: rect(send), input: rect(input), row: rect(row), composer: rect(comp), inputrow: rect(inputrow), inRow: row.contains(send), vw: innerWidth,
      rowKids: [...row.children].map((c) => c.className), state: send.dataset.state };
  });
  if (want('composer')) for (const [label, width, extra] of [['360', 360, ''], ['560', 560, ''], ['960', 960, ''], ['360 monospace + nowrap', 360, 'button { white-space: nowrap; } body, .sb-ai, .sb-ai button, .sb-ai select, .sb-ai textarea { font-family: monospace !important; font-size: 15px !important; }']]) {
    const page = await open(live({ tokens: 'obsidian', bare: '1', w: String(width) }), { width, height: 700 });
    if (extra) await page.addStyleTag({ content: extra });
    await page.evaluate(() => window.__sbL.make());
    const after = await composerBox(page);
    // the old arrangement, for the numbers: send back at the end of the controls row
    await page.evaluate(() => document.querySelector('.sb-ai-box > .sb-ai-row:not(.sb-ai-report-options)').append(document.querySelector('.sb-ai-send')));
    const before = await composerBox(page);
    await page.evaluate(() => document.querySelector('.sb-ai-inputrow').append(document.querySelector('.sb-ai-send')));
    const back = await composerBox(page);
    const insideInputRow = after.send.top >= after.input.top - 1 && after.send.bottom <= after.inputrow.bottom + 1 && after.send.top < after.row.top;
    const visible = after.send.right <= after.vw && after.send.left >= 0 && after.send.width > 0;
    const noExtra = after.composer.height - (after.inputrow.height + after.row.height) <= 60;
    check(`composer @ ${label}: send sits in the message-box row (top ${after.send.top} < controls top ${after.row.top}), visible, not in the controls row`,
      insideInputRow && visible && !after.inRow && noExtra, after);
    check(`composer @ ${label}: height ${after.composer.height}px (before, send in the controls row: ${before.composer.height}px) and identical when put back`,
      after.composer.height <= before.composer.height && back.composer.height === after.composer.height, { before: before.composer.height, after: after.composer.height, back: back.composer.height });
    console.log(`  composer @ ${label}: before ${before.composer.height}px, after ${after.composer.height}px (controls row ${after.row.height}px, message row ${after.inputrow.height}px)`);
    if (label.startsWith('360 mono') || label === '560') await page.screenshot({ path: join(outDir, `composer-${label.replace(/[^a-z0-9]+/gi, '-')}.png`) });
    // running: the button becomes Stop in the same place
    await page.evaluate(() => { window.__sbL.view.input.value = 'hello'; window.__sbL.view.input.dispatchEvent(new Event('input')); });
    const idle = await composerBox(page);
    const started = await page.evaluate(() => window.__sbL.start('hello'));
    const running = await composerBox(page);
    check(`composer @ ${label}: while running the button is Stop, in the same place (${running.state})`, running.state === 'stop' && Math.abs(running.send.top - idle.send.top) <= idle.input.height && running.send.top < running.row.top && !running.inRow, { idle, running });
    await page.evaluate((i) => window.__sbL.end(i), started).catch(() => {});
    await page.close();
  }
  // Where the old arrangement wrapped send onto a row of its own (a wide monospace font): the saving, measured over a range of widths.
  if (want('composer')) {
    const page = await open(live({ tokens: 'obsidian', bare: '1', w: '900' }), { width: 900, height: 700 });
    await page.addStyleTag({ content: 'button { white-space: nowrap; } body, .sb-ai, .sb-ai button, .sb-ai select, .sb-ai textarea { font-family: monospace !important; font-size: 15px !important; }' });
    await page.evaluate(() => window.__sbL.make());
    const scan = [];
    for (const w of [360, 420, 480, 520, 560, 600, 640, 700, 760, 820, 900]) {
      await page.evaluate((px) => { document.getElementById('frame').style.width = `${px}px`; }, w);
      await page.waitForTimeout(60);
      const after = (await composerBox(page)).composer.height;
      await page.evaluate(() => document.querySelector('.sb-ai-box > .sb-ai-row:not(.sb-ai-report-options)').append(document.querySelector('.sb-ai-send')));
      const before = (await composerBox(page)).composer.height;
      await page.evaluate(() => document.querySelector('.sb-ai-inputrow').append(document.querySelector('.sb-ai-send')));
      scan.push({ w, before, after });
    }
    const saved = Math.max(...scan.map((x) => x.before - x.after));
    check(`composer, monospace + nowrap, widths 360-900: never taller than before (biggest saving ${saved}px, one lone-send row)`, scan.every((x) => x.after <= x.before), scan);
    console.log(`  composer width scan (before/after px): ${scan.map((x) => `${x.w}: ${x.before}/${x.after}`).join(', ')}`);
    await page.close();
  }

  if (want('composer')) for (const theme of ['light', 'dark']) {
    for (const tokens of ['zotero', 'obsidian']) {
      const page = await open(live({ tokens, theme, w: '560' }), { width: 600, height: 700 }, theme);
      await page.evaluate(() => window.__sbL.make());
      const colors = await page.evaluate(() => { const s = getComputedStyle(document.querySelector('.sb-ai-send')); return { bg: s.backgroundColor, fg: s.color }; });
      check(`composer ${tokens}/${theme}: send button has a fill and a contrasting arrow`, colors.bg !== 'rgba(0, 0, 0, 0)' && colors.bg !== colors.fg, colors);
      await page.screenshot({ path: join(outDir, `composer-${tokens}-${theme}.png`) });
      await page.close();
    }
  }

  // ================================================================ Chat with papers: send beside the box
  if (want('papers')) for (const [label, viewport, w, narrow] of [['column 1100', { width: 1132, height: 800 }, '1100', false], ['360', { width: 360, height: 780 }, '', true]]) {
    const page = await open(`http://127.0.0.1:${port}/dev/harness/artifacts.html?${new URLSearchParams({ tokens: 'obsidian', w, ...(narrow ? { bare: '1' } : {}) })}`, viewport);
    await page.addStyleTag({ content: 'button { white-space: nowrap; } body, .sb-ai, .sb-ai button, .sb-ai textarea { font-family: monospace !important; font-size: 15px !important; }' });
    if (narrow) await page.locator('.sb-art-card', { hasText: 'Papers' }).last().click();
    else await page.evaluate(async () => { await window.__sbA.chat.openArtifact({ id: 'R1' }); });
    await page.waitForSelector('.sb-art-tab');
    await page.locator('.sb-art-tab', { hasText: narrow ? /^Chat$/ : /^Chat with papers$/ }).click();
    await page.waitForSelector('.sb-pc-input');
    const m = await page.evaluate(() => {
      const q = (s) => document.querySelector(s);
      const rect = (e) => { const r = e.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), height: Math.round(r.height) }; };
      return { send: rect(q('.sb-pc-send')), input: rect(q('.sb-pc-input')), box: rect(q('.sb-pc-box')), scope: rect(q('.sb-pc-scope')), composer: rect(q('.sb-pc-composer')), vw: innerWidth };
    });
    check(`papers-chat composer @ ${label} (monospace, nowrap): send is inside the message box beside the input, visible, above the scope line`,
      m.send.top >= m.box.top && m.send.bottom <= m.box.bottom && m.send.left > m.input.left && m.send.right <= m.vw && m.send.top < m.scope.top && m.composer.height <= m.box.height + m.scope.height + 40, m);
    console.log(`  papers-chat composer @ ${label}: ${m.composer.height}px (box ${m.box.height}px, scope line ${m.scope.height}px)`);
    await page.screenshot({ path: join(outDir, `composer-papers-${label.replace(/[^a-z0-9]+/gi, '-')}.png`) });
    await page.close();
  }

  return { failures, count };
}
