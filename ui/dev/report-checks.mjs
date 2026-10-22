// ui-src/dev/report-checks.mjs. Playwright checks for spec 007 E7 (the clarify card, the plan card's criteria and columns,
// stage lines, evidence claims opening their quotes) in a real ChatView on the fake host, run by dev/run.mjs against
// dev/harness/report.html. Screenshots go to dev/out/. Every claim about layout is measured, not eyeballed.
import { join } from 'node:path';

/** @param {import("playwright").Browser} browser @param {number} port @param {string} outDir */
export async function runReportChecks(browser, port, outDir) {
  let failures = 0;
  let count = 0;
  const check = (name, ok, detail) => {
    count += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'} report: ${name}${ok ? '' : ` :: ${JSON.stringify(detail)}`}`);
    if (!ok) failures += 1;
  };
  async function open(script, { tokens = 'zotero', theme = 'light', w } = {}, viewport = { width: 1000, height: 820 }) {
    const page = await browser.newPage({ viewport, colorScheme: theme });
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
    await page.goto(`http://127.0.0.1:${port}/dev/harness/report.html?${new URLSearchParams({ tokens, theme, ...(w ? { w } : {}) })}`);
    await page.waitForFunction(() => window.__sbHarnessReady === true, null, { timeout: 8000 });
    await page.evaluate((names) => window.__sbRp.make({ script: names.map((n) => window.__sbRp.STATES[n]) }), script);
    page.errors = errors;
    return page;
  }
  const calls = (page) => page.evaluate(() => window.__sbLastCalls ?? null);
  const noScroll = (page) => page.evaluate(() => {
    const thread = document.querySelector('.sb-ai-thread');
    return document.documentElement.scrollWidth <= document.documentElement.clientWidth && thread.scrollWidth <= thread.clientWidth;
  });

  for (const tokens of ['zotero', 'obsidian']) {
    for (const theme of ['light', 'dark']) {
      const tag = `${tokens}/${theme}`;
      // ============================================================ the clarify card
      let page = await open(['asking', 'planning'], { tokens, theme });
      const card = await page.evaluate(() => {
        const c = document.querySelector('.sb-rp-clarify');
        if (!c) return null;
        const qs = [...c.querySelectorAll('.sb-rp-clarify-q')];
        return {
          head: c.querySelector('.sb-rp-clarify-head')?.textContent, n: qs.length,
          texts: qs.map((q) => q.querySelector('.sb-rp-clarify-text').textContent),
          choices: qs.map((q) => [...q.querySelectorAll('.sb-rp-clarify-label')].map((l) => l.textContent)),
          nums: qs.map((q) => [...q.querySelectorAll('.sb-rp-clarify-n')].map((l) => l.textContent)),
          other: qs.map((q) => Boolean(q.querySelector('.sb-rp-clarify-other'))),
          decide: c.querySelector('.sb-rp-clarify-decide')?.textContent,
          plan: Boolean(document.querySelector('.sb-rp-plan')), step: document.querySelector('.sb-rp-step')?.textContent,
        };
      });
      check(`${tag}: the clarify card shows a "Question" header, both questions with numbered choices, "Other…" only where allowed, and "You decide"`,
        card && card.head === 'Question' && card.n === 2 && card.nums[0].join() === '1,2,3' && card.nums[1].join() === '1,2' && card.other.join() === 'true,false' && card.decide === 'You decide' && !card.plan, card);
      check(`${tag}: the step line says where the review is ("Step 1 of 8 · Check the question")`, /Step 1 of 8/.test(card.step) && /Check the question/.test(card.step), card.step);
      await page.screenshot({ path: join(outDir, `report-clarify-${tag.replace('/', '-')}.png`) });
      const wrapped = await page.evaluate(() => {
        const label = document.querySelector('.sb-rp-clarify-label'); const btn = document.querySelector('.sb-rp-clarify-choice');
        return { white: getComputedStyle(btn).whiteSpace, w: label.getBoundingClientRect().width, cw: btn.getBoundingClientRect().width };
      });
      check(`${tag}: a long choice wraps inside its row (white-space: normal, not the host button's nowrap)`, wrapped.white === 'normal' && wrapped.w <= wrapped.cw, wrapped);

      // one answer does not send; the second (by number key) does, with both answers
      await page.locator('.sb-rp-clarify-choice').nth(1).click();
      await page.waitForTimeout(50);
      const beforeSecond = await page.locator('.sb-rp-clarify').count();
      check(`${tag}: one answered question waits for the other (the card is still there)`, beforeSecond === 1 && (await page.locator('.sb-rp-clarify-choice.is-picked').count()) === 1, beforeSecond);
      await page.locator('.sb-rp-clarify').focus();
      await page.keyboard.press('2');
      await page.waitForFunction(() => !document.querySelector('.sb-rp-clarify') || document.querySelector('.sb-rp-plan'), null, { timeout: 4000 });
      await page.waitForSelector('.sb-rp-plan', { timeout: 4000 });
      const answered = await page.evaluate(() => window.__sbRp.callsOf());
      const answer = answered.find((c) => c.kind === 'answer');
      check(`${tag}: both answered -> reviews.answer once, with the choice indexes (route 1, when 1 via the number key), then the plan appears`,
        answer && answer.answers.length === 2 && answer.answers[0].choice === 1 && answer.answers[1].choice === 1 && answered.filter((c) => c.kind === 'answer').length === 1, answered);
      check(`${tag}: no page errors`, page.errors.length === 0, page.errors);
      await page.close();

      // "Other…" and "You decide"
      page = await open(['asking', 'planning'], { tokens, theme });
      await page.locator('.sb-rp-clarify-other').click();
      await page.keyboard.type('  scoping review ');
      await page.keyboard.press('Enter');
      await page.locator('.sb-rp-clarify-decide').click();
      await page.waitForSelector('.sb-rp-plan', { timeout: 4000 });
      const a2 = (await page.evaluate(() => window.__sbRp.callsOf())).find((c) => c.kind === 'answer').answers;
      check(`${tag}: typing in Other… answers with that text, and "You decide" leaves the rest null + null`,
        a2[0].other === 'scoping review' && a2[0].choice === null && a2[1].choice === null && a2[1].other === null, a2);
      await page.close();

      // ============================================================ the plan card
      page = await open(['planning'], { tokens, theme });
      const plan = await page.evaluate(() => {
        const t = (s) => [...document.querySelectorAll(s)].map((n) => n.textContent.trim());
        const strict = document.querySelector('.sb-rp-strict');
        return {
          items: t('.sb-rp-plan-q'), criteria: t('.sb-rp-criterion-text'), chips: t('.sb-rp-chip-name'), sections: t('.sb-rp-section-title'),
          assumed: t('.sb-rp-assumed'), toggles: t('.sb-rp-strict'), strictOpacity: getComputedStyle(strict).opacity, primary: t('.sb-button.is-primary'),
          lines: t('.sb-rp-line'), step: document.querySelector('.sb-rp-step').textContent,
        };
      });
      check(`${tag}: the plan card lists the sub-questions, then criteria, columns to extract, and what was assumed`,
        plan.items.length === 2 && plan.criteria.join('|') === 'Reports a field study|Published after 2010' && plan.chips.join('|') === 'Main findings|Sample size'
        && plan.sections.join('|') === 'Criteria|Columns to extract' && plan.assumed[0] === 'Assumed: 2015 onward' && plan.primary[0] === 'Start research', plan);
      check(`${tag}: the Strict / Preferred toggle is hidden until hover (opacity 0) and reads "Strict" for the strict criterion`, plan.strictOpacity === '0' && plan.toggles.join('|') === 'Strict|Preferred', plan);
      check(`${tag}: the finished clarify stage is a quiet line above the step line`, plan.lines[0]?.startsWith('Clarified the scope') && /Step 3 of 8/.test(plan.step), plan);
      await page.locator('.sb-rp-criterion').first().hover();
      const hovered = await page.evaluate(() => getComputedStyle(document.querySelector('.sb-rp-strict')).opacity);
      check(`${tag}: hovering a criterion shows its toggle`, hovered === '1', hovered);
      await page.screenshot({ path: join(outDir, `report-plan-${tag.replace('/', '-')}.png`) });

      // edit: flip the second criterion to strict, drop the first column, add "Population"
      await page.locator('.sb-rp-criterion').nth(1).hover();
      await page.locator('.sb-rp-strict').nth(1).click();
      await page.locator('.sb-rp-chip').first().hover();
      await page.locator('.sb-rp-chip-x').first().click();
      await page.locator('.sb-rp-chip-add').click();
      await page.keyboard.type('Population');
      await page.keyboard.press('Enter');
      await page.locator('.sb-button.is-primary', { hasText: 'Start research' }).click();
      await page.waitForTimeout(150);
      const approve = (await page.evaluate(() => window.__sbRp.callsOf())).find((c) => c.kind === 'approve');
      check(`${tag}: Start research sends the edited plan: criteria (second now strict), columns (Main findings removed, Population added with an id), assumed kept, caps kept`,
        approve && approve.plan.criteria[1].strict === true && approve.plan.criteria[0].strict === true
        && approve.plan.columns.map((c) => `${c.id}:${c.name}`).join('|') === 'sample_size:Sample size|population:Population'
        && approve.plan.assumed[0] === 'Assumed: 2015 onward' && approve.plan.caps.extract === 20 && approve.plan.subQuestions.length === 2, approve);
      check(`${tag}: no page errors`, page.errors.length === 0, page.errors);
      await page.close();

      // a pipeline-1 plan (no lines, no criteria) still looks and sends as before
      page = await open(['old'], { tokens, theme });
      const old = await page.evaluate(() => ({ extras: Boolean(document.querySelector('.sb-rp-extras')), step: document.querySelector('.sb-rp-step').textContent, items: document.querySelectorAll('.sb-rp-plan-q').length }));
      check(`${tag}: a pipeline-1 plan has no criteria/columns sections and the old 6-step line`, !old.extras && /Step 2 of 6/.test(old.step) && old.items === 2, old);
      await page.locator('.sb-button.is-primary', { hasText: 'Start research' }).click();
      await page.waitForTimeout(100);
      const oldApprove = (await page.evaluate(() => window.__sbRp.callsOf())).find((c) => c.kind === 'approve');
      check(`${tag}: ...and approving it sends only { subQuestions }`, oldApprove && Object.keys(oldApprove.plan).join() === 'subQuestions', oldApprove);
      await page.close();

      // ============================================================ running: lines + agents
      page = await open(['searching'], { tokens, theme });
      const running = await page.evaluate(() => ({
        lines: [...document.querySelectorAll('.sb-rp-line')].map((n) => n.textContent.trim()), step: document.querySelector('.sb-rp-step').textContent,
        agents: [...document.querySelectorAll('.sb-rp-agent')].map((n) => n.textContent.trim()), stop: [...document.querySelectorAll('.sb-button')].map((b) => b.textContent),
      }));
      check(`${tag}: while searching: done stages as lines, "Search for papers" as the step, one row per sub-question, a Stop button`,
        running.lines.length === 2 && /Step 4 of 8/.test(running.step) && /Search for papers/.test(running.step) && running.agents.length === 2 && running.stop.includes('Stop'), running);
      await page.close();

      page = await open(['extracting'], { tokens, theme });
      const extracting = await page.evaluate(() => document.querySelector('.sb-rp-step').textContent);
      check(`${tag}: while extracting: "Step 6 of 8 · Read and extract · 12 papers found"`, /Step 6 of 8/.test(extracting) && /Read and extract/.test(extracting) && /12 papers found/.test(extracting), extracting);
      await page.close();

      // ============================================================ the finished report: evidence -> quotes
      page = await open(['done'], { tokens, theme });
      const done = await page.evaluate(() => ({
        sub: document.querySelector('.sb-rp-sub').textContent, rows: document.querySelectorAll('.sb-rp-evidence tr.is-linked').length,
        cells: document.querySelectorAll('.sb-rp-evidence-cells').length,
      }));
      check(`${tag}: the report's subtitle counts what the files say ("2 papers included · 12 found") and the claim that rests on quotes is clickable (the other rests only on a not-found cell, so it is not)`, done.sub === '2 papers included · 12 found' && done.rows === 1 && done.cells === 0, done);
      await page.locator('.sb-rp-evidence tr.is-linked').first().click();
      const quotes = await page.evaluate(() => {
        const box = document.querySelector('.sb-rp-evidence-cells');
        return box ? {
          heads: [...box.querySelectorAll('.sb-rp-cell-head')].map((n) => n.textContent), values: [...box.querySelectorAll('.sb-rp-cell-value')].map((n) => n.textContent),
          quotes: [...box.querySelectorAll('.sb-rp-quote')].map((n) => ({ t: n.textContent, unverified: n.classList.contains('is-unverified') })),
          cols: box.querySelector('td').colSpan,
        } : null;
      });
      check(`${tag}: clicking a claim opens the cells it rests on: paper · column, value, and each quote, the planted wrong quote marked Unverified`,
        quotes && quotes.heads.join('|') === 'Winter diets of field voles (2020) · Main findings|Winter diets of field voles (2020) · Sample size'
        && quotes.values[0] === 'Voles ate mostly bark' && quotes.quotes.length === 3 && quotes.quotes.filter((q) => q.unverified).length === 1 && /Unverified/.test(quotes.quotes.find((q) => q.unverified).t) && quotes.cols === 3, quotes);
      await page.screenshot({ path: join(outDir, `report-evidence-${tag.replace('/', '-')}.png`) });
      await page.locator('.sb-rp-evidence tr.is-linked').first().click();
      check(`${tag}: clicking again closes it`, (await page.locator('.sb-rp-evidence-cells').count()) === 0, null);
      // the second claim rests only on a "not found" cell: nothing to show, so it opens nothing
      await page.locator('.sb-rp-evidence tr').nth(2).click().catch(() => {});
      check(`${tag}: a claim whose cells hold no quotes is not a link`, (await page.locator('.sb-rp-evidence tr.is-linked').count()) === 1, await page.locator('.sb-rp-evidence tr.is-linked').count());
      check(`${tag}: no page errors`, page.errors.length === 0, page.errors);
      await page.close();
    }
  }

  for (const tokens of ['zotero', 'obsidian']) {
    for (const theme of ['light', 'dark']) {
      const tag = `${tokens}/${theme}`;
      // ============================================================ a systematic review's protocol card (spec 007 E8)
      let page = await open(['sysPlanning'], { tokens, theme });
      const sys = await page.evaluate(() => {
        const t = (s) => [...document.querySelectorAll(s)].map((n) => n.textContent.trim());
        return {
          sections: t('.sb-rp-section-title'), labels: t('.sb-rp-protocol-label'), values: t('.sb-rp-protocol-value'), criteria: t('.sb-rp-criterion-text'),
          primary: t('.sb-button.is-primary')[0], step: document.querySelector('.sb-rp-step').textContent, caps: [...document.querySelectorAll('.sb-rp-caps-input')].map((i) => i.value),
          addCriterion: t('.sb-rp-section .sb-rp-chip-add').includes('Add a criterion'), placeholder: document.querySelectorAll('.sb-rp-protocol-value')[2].dataset.placeholder,
        };
      });
      check(`${tag}: the protocol card shows five labelled PICOS lines, criteria, columns and the caps, and the button says Start review`,
        sys.sections.join('|') === 'Protocol|Criteria|Columns to extract' && sys.labels.join('|') === 'Population|Intervention|Comparison|Outcomes|Study designs'
        && sys.values[0] === 'Adult learners' && sys.values[2] === '' && sys.placeholder === 'Not applicable' && sys.values[4] === 'RCT, meta-analysis'
        && sys.primary === 'Start review' && sys.caps.join() === '300,80' && sys.addCriterion, sys);
      check(`${tag}: the step line counts nine stages for a systematic review`, /Step 3 of 9/.test(sys.step), sys.step);
      await page.screenshot({ path: join(outDir, `report-protocol-${tag.replace('/', '-')}.png`) });
      // the only strict criterion cannot be removed or made preferred
      await page.locator('.sb-rp-criterion').first().hover();
      await page.locator('.sb-rp-strict').first().click();
      await page.locator('.sb-rp-criterion .sb-rp-plan-x').first().click();
      const guarded = await page.evaluate(() => ({ criteria: document.querySelectorAll('.sb-rp-criterion').length, first: document.querySelector('.sb-rp-strict').textContent, notices: window.__sbRp.callsOf().filter((c) => c.kind === 'notice').map((c) => c.text) }));
      check(`${tag}: the last strict criterion can be neither removed nor made preferred (a notice says why)`, guarded.criteria === 2 && guarded.first === 'Strict' && guarded.notices.length === 2 && /at least one strict/.test(guarded.notices[0]), guarded);
      // edit: a new protocol line, a bigger cap, one more strict criterion, then start
      await page.locator('.sb-rp-protocol-value').nth(2).click();
      await page.keyboard.type('Massed practice');
      await page.locator('.sb-rp-protocol-value').nth(4).evaluate((n) => { n.focus(); getSelection().selectAllChildren(n); });
      await page.keyboard.type('RCT; nonsense');
      await page.locator('.sb-rp-caps-input').first().fill('150');
      await page.locator('.sb-rp-section .sb-rp-chip-add', { hasText: 'Add a criterion' }).click();
      await page.keyboard.type('Published after 2010');
      await page.locator('.sb-rp-criterion .sb-rp-strict').nth(2).evaluate((n) => n.click());
      await page.locator('.sb-button.is-primary', { hasText: 'Start review' }).click();
      await page.waitForTimeout(150);
      const plan = (await page.evaluate(() => window.__sbRp.callsOf())).find((c) => c.kind === 'approve')?.plan;
      check(`${tag}: Start review sends the edited protocol (comparison typed, designs parsed and the unknown word dropped), caps (150 / 80) and criteria (3, two strict)`,
        plan && plan.protocol.comparison === 'Massed practice' && plan.protocol.studyDesigns.join() === 'rct' && plan.protocol.population === 'Adult learners'
        && plan.caps.candidates === 150 && plan.caps.extract === 80 && plan.criteria.length === 3 && plan.criteria.filter((c) => c.strict).length === 2 && plan.criteria[2].id === 'criterion_3', plan);
      check(`${tag}: no page errors`, page.errors.length === 0, page.errors);
      await page.close();

      // ============================================================ the unclear papers
      page = await open(['sysReview', 'sysReview'], { tokens, theme });
      await page.evaluate(() => { window.__sbRp.chat.openScreening = undefined; }); // the inline list is the fallback for a host with no side panel
      const rev = await page.evaluate(() => ({
        text: document.querySelector('.sb-rp-unclear-text')?.textContent, buttons: [...document.querySelectorAll('.sb-rp-unclear .sb-button')].map((b) => [b.textContent, b.hidden]),
        rows: document.querySelectorAll('.sb-rp-unclear-row').length, listHidden: document.querySelector('.sb-rp-unclear-list').hidden, step: document.querySelector('.sb-rp-step').textContent,
      }));
      check(`${tag}: more than 10% unclear: the card says how many, offers Include them all and Let me look, and the list starts closed`,
        /3 of 20 papers are unclear/.test(rev.text) && rev.buttons.map((b) => b[0]).join('|') === 'Include them all|Let me look|Continue' && rev.buttons[2][1] === true && rev.listHidden && /Step 6 of 9/.test(rev.step) && /Check the unclear papers/.test(rev.step), rev);
      await page.locator('.sb-button', { hasText: 'Let me look' }).click();
      const look = await page.evaluate(() => ({
        rows: [...document.querySelectorAll('.sb-rp-unclear-row')].map((r) => ({ title: r.querySelector('.sb-rp-unclear-title').textContent, why: r.querySelector('.sb-rp-unclear-why')?.textContent, toggle: r.querySelector('.sb-rp-unclear-toggle').textContent })),
        buttons: [...document.querySelectorAll('.sb-rp-unclear .sb-button')].filter((b) => !b.hidden).map((b) => b.textContent),
        box: (() => { const l = document.querySelector('.sb-rp-unclear-list'); return { sw: l.scrollWidth, cw: l.clientWidth }; })(),
      }));
      check(`${tag}: Let me look lists each paper with the criterion it was unclear on, all Included, and only Continue remains`,
        look.rows.length === 3 && look.rows[0].title === 'Spacing in undergraduates (2019)' && look.rows[1].why === 'Unclear on: Enrolled adults; Reports a retention outcome' && look.rows.every((r) => r.toggle === 'Included')
        && look.buttons.join() === 'Continue' && look.box.sw <= look.box.cw, look);
      await page.screenshot({ path: join(outDir, `report-unclear-${tag.replace('/', '-')}.png`) });
      await page.locator('.sb-rp-unclear-toggle').nth(1).click();
      const left = await page.evaluate(() => ({ toggle: document.querySelectorAll('.sb-rp-unclear-toggle')[1].textContent, out: document.querySelectorAll('.sb-rp-unclear-row.is-out').length }));
      check(`${tag}: turning a paper off reads "Left out" and strikes its title`, left.toggle === 'Left out' && left.out === 1, left);
      await page.locator('.sb-button', { hasText: 'Continue' }).click();
      await page.waitForTimeout(150);
      const sent = (await page.evaluate(() => window.__sbRp.callsOf())).filter((c) => c.kind === 'screened');
      check(`${tag}: Continue sends only the papers turned off`, sent.length === 1 && JSON.stringify(sent[0].overrides) === JSON.stringify([{ id: 'p:b', include: false }]), sent);
      await page.close();

      page = await open(['sysReview', 'sysReview'], { tokens, theme });
      await page.locator('.sb-button', { hasText: 'Include them all' }).click();
      await page.waitForTimeout(150);
      const all = (await page.evaluate(() => window.__sbRp.callsOf())).filter((c) => c.kind === 'screened');
      check(`${tag}: Include them all sends no overrides`, all.length === 1 && all[0].overrides.length === 0, all);
      check(`${tag}: no page errors`, page.errors.length === 0, page.errors);
      await page.close();

      // ============================================================ the unclear papers in the side panel (spec 007 E8)
      page = await open(['sysReview', 'sysReview'], { tokens, theme });
      await page.locator('.sb-button', { hasText: 'Let me look' }).click();
      await page.waitForSelector('.sb-art-gate-toggle', { timeout: 4000 });
      const panel = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('.sb-art-row')];
        const banner = document.querySelector('.sb-art-banner');
        return {
          card: document.querySelector('.sb-rp-unclear-text').textContent, cardButtons: [...document.querySelectorAll('.sb-rp-unclear .sb-button')].filter((b) => !b.hidden).map((b) => b.textContent),
          inlineHidden: document.querySelector('.sb-rp-unclear-list').hidden,
          banner: banner && !banner.hidden ? banner.querySelector('.sb-art-banner-text').textContent : null, bannerButtons: [...document.querySelectorAll('.sb-art-banner-btn')].map((b) => b.textContent),
          title: document.querySelector('.sb-art-head-text')?.textContent,
          rows: rows.length, toggles: rows.map((r) => r.querySelector('.sb-art-gate-toggle')?.textContent),
          why: rows.map((r) => r.querySelector('.sb-art-gate-why')?.textContent),
          chips: [...document.querySelectorAll('.sb-art-chip-filter, .sb-art-chips > *')].map((n) => n.textContent),
          tabs: [...document.querySelectorAll('.sb-art-tabs button')].map((b) => b.textContent), keep: Boolean(document.querySelector('.sb-art-keep')), more: Boolean(document.querySelector('.sb-art-head [aria-label="More"]')),
        };
      });
      check(`${tag}: Let me look opens the screened papers in the side panel, and the card says so instead of listing them`,
        panel.title === 'Screened papers' && /open beside the chat/.test(panel.card) && panel.cardButtons.join() === 'Include them all' && panel.inlineHidden, panel);
      check(`${tag}: the panel opens on the 3 unclear papers (Screening: Unclear), each with the criteria it was unclear on and an Included switch`,
        panel.rows === 3 && panel.toggles.every((t) => t === 'Included in the review') && panel.why[1] === 'Unclear on: Enrolled adults; Reports a retention outcome' && panel.chips.some((t) => /Screening: Unclear/.test(t)), panel);
      check(`${tag}: the banner counts the unclear papers and offers Include them all and Continue; the chat tab is not offered for it`,
        /3 of 20 papers are unclear/.test(panel.banner ?? '') && panel.bannerButtons.join('|') === 'Include them all|Continue with all of them' && panel.tabs.length === 0 && !panel.keep && !panel.more, panel);
      await page.screenshot({ path: join(outDir, `report-gate-${tag.replace('/', '-')}.png`) });
      await page.locator('.sb-art-gate-toggle').nth(1).click();
      const off = await page.evaluate(() => {
        const toggles = [...document.querySelectorAll('.sb-art-gate-toggle')];
        const buttons = [...document.querySelectorAll('.sb-art-banner-btn')];
        const td = toggles[1].closest('td').getBoundingClientRect(); const t = toggles[1].getBoundingClientRect();
        return {
          text: toggles[1].textContent, pressed: toggles[1].getAttribute('aria-pressed'), dim: document.querySelectorAll('.sb-art-row.is-gate-out').length, go: buttons[1].textContent,
          white: [getComputedStyle(toggles[1]).whiteSpace, ...buttons.map((b) => getComputedStyle(b).whiteSpace)], inside: t.right <= td.right + 0.5 && t.left >= td.left - 0.5,
        };
      });
      check(`${tag}: turning a paper off reads "Left out of the review", dims its row, updates Continue, and the long text wraps (white-space: normal) inside its cell`,
        off.text === 'Left out of the review' && off.pressed === 'false' && off.dim === 1 && off.go === 'Continue, leaving out 1' && off.white.every((w) => w === 'normal') && off.inside, off);
      await page.locator('.sb-art-gate-go').click();
      await page.waitForTimeout(250);
      const sentPanel = (await page.evaluate(() => window.__sbRp.callsOf())).filter((c) => c.kind === 'screened');
      const after = await page.evaluate(() => ({ gates: document.querySelectorAll('.sb-art-gate').length, bannerShown: !document.querySelector('.sb-art-banner').hidden, gateBanner: document.querySelector('.sb-art-banner').classList.contains('is-gate'),
        out: [...document.querySelectorAll('.sb-art-row')].filter((r) => r.getAttribute('data-row') === 'p:b').length }));
      check(`${tag}: Continue in the panel sends only the papers turned off through reviews.screened, then the toggles and the gate banner are gone`,
        sentPanel.length === 1 && sentPanel[0].id === 'review1' && JSON.stringify(sentPanel[0].overrides) === JSON.stringify([{ id: 'p:b', include: false }]) && after.gates === 0 && !after.gateBanner && !after.bannerShown, { sentPanel, after });
      check(`${tag}: no page errors`, page.errors.length === 0, page.errors);
      await page.close();

      page = await open(['sysReview', 'sysReview'], { tokens, theme });
      await page.locator('.sb-button', { hasText: 'Let me look' }).click();
      await page.waitForSelector('.sb-art-gate-all', { timeout: 4000 });
      await page.locator('.sb-art-gate-all').click();
      await page.waitForTimeout(250);
      const panelAll = (await page.evaluate(() => window.__sbRp.callsOf())).filter((c) => c.kind === 'screened');
      check(`${tag}: Include them all in the panel sends no overrides`, panelAll.length === 1 && panelAll[0].overrides.length === 0, panelAll);
      await page.close();

      // phone width: the panel is a full view and each unclear paper is a card with its switch
      page = await open(['sysReview', 'sysReview'], { tokens, theme }, { width: 360, height: 780 });
      await page.locator('.sb-button', { hasText: 'Let me look' }).click();
      await page.waitForSelector('.sb-art-gate-toggle', { timeout: 4000 });
      const narrow = await page.evaluate(() => {
        const card = document.querySelector('.sb-art-rowcard'); const toggle = card.querySelector('.sb-art-gate-toggle'); const c = card.getBoundingClientRect(); const t = toggle.getBoundingClientRect();
        const banner = document.querySelector('.sb-art-banner');
        return { cards: document.querySelectorAll('.sb-art-rowcard').length, inside: t.right <= c.right + 0.5, page: document.documentElement.scrollWidth <= document.documentElement.clientWidth, bannerFits: banner.scrollWidth <= banner.clientWidth + 1, white: getComputedStyle(toggle).whiteSpace };
      });
      check(`${tag}: at 360 px the unclear papers are cards with their switch inside, the banner fits and nothing scrolls sideways`,
        narrow.cards === 3 && narrow.inside && narrow.page && narrow.bannerFits && narrow.white === 'normal', narrow);
      await page.screenshot({ path: join(outDir, `report-gate-360-${tag.replace('/', '-')}.png`) });
      await page.close();
    }
  }

  // ============================================================ the search stage shows the researchers' calls live
  for (const tokens of ['zotero', 'obsidian']) {
    const page = await open(['searchLive'], { tokens, theme: 'light' });
    const live = await page.evaluate(() => ({
      head: document.querySelector('.sb-rp-live-head')?.textContent,
      steps: [...document.querySelectorAll('.sb-rp-live-row')].map((n) => n.textContent.trim()),
      running: document.querySelectorAll('.sb-rp-live-row.is-running').length,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    }));
    check(`${tokens}: the stage now running lists its researchers' calls as they happen, the one in progress marked`,
      live.head === 'Searching · 2 searches · 1 read' && live.steps.length === 3 && /^✓\s*Searched OpenAlex/.test(live.steps[0]) && live.running === 1 && !live.overflow, live);
    await page.close();
  }

  // the composer: choosing Systematic review starts a systematic pipeline-2 review
  {
    const page = await open(['sysPlanning']);
    const req = await page.evaluate(async () => {
      const chat = window.__sbRp.chat;
      chat.setMode('systematic', { fresh: false });
      const modes = [...chat.modePick.options].map((o) => o.textContent);
      await chat.startReport('Does spaced practice help adults?');
      return { modes, sent: window.__sbRp.callsOf().find((c) => c.kind === 'review')?.req };
    });
    check('choosing Systematic review starts a pipeline-2 review flagged systematic, with the composer\'s depth and years', req.modes.includes('Systematic review') && req.sent?.pipeline === 2 && req.sent.systematic === true && req.sent.depth === 'standard', req);
    await page.close();
  }

  // ============================================================ narrow widths, no horizontal scroll
  for (const width of [360, 700]) {
    for (const state of ['asking', 'planning', 'done']) {
      const page = await open([state], { tokens: 'zotero', w: String(width) }, { width: width + 40, height: 820 });
      if (state === 'done') await page.locator('.sb-rp-evidence tr.is-linked').first().click();
      const ok = await noScroll(page);
      const box = await page.evaluate(() => { const t = document.querySelector('.sb-ai-thread'); return { sw: t.scrollWidth, cw: t.clientWidth }; });
      check(`${width}px ${state}: no horizontal scroll`, ok, box);
      await page.screenshot({ path: join(outDir, `report-${state}-${width}.png`) });
      await page.close();
    }
  }
  return { failures, count };
}
