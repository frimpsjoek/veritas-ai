// ui-src/dev/web-checks.mjs. Playwright checks for the browser app (spec 013 W1) against the built bundle in dist-web/:
//  - the shell on a fake web host (dev/harness/web.html): every route, one ChatView, a chat turn, Home, Routines;
//  - the real web host and transport against a scripted server (page.route): state write-through, a turn through the
//    agent forward and its long-poll stream, the offline notice.
// Both at 1280 / 700 / 360 px with no sideways page scroll. Invented content only. Run by dev/run.mjs (SB_ONLY=web).
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { useFixtures } from './web-fixtures.mjs';
import { validateDraft } from '../../agent/src/routines.js';
import { formFromRoutine } from '../src/chat/radar-data.js';

const dist = fileURLToPath(new URL('../../web/dist-web', import.meta.url));
const WIDTHS = [1280, 700, 360];
const ROUTES = ['home', 'chat', 'routines', 'projects', 'settings', 'library'];

/** @param {import("playwright").Browser} browser @param {number} port @param {string} outDir */
export async function runWebChecks(browser, port, outDir) {
  let failures = 0;
  let count = 0;
  const check = (name, ok, detail) => {
    count += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'} web: ${name}${ok ? '' : ` :: ${JSON.stringify(detail)}`}`);
    if (!ok) failures += 1;
  };

  const files = readdirSync(dist);
  const js = files.find((f) => /^app-[0-9a-f]{8}\.js$/.test(f));
  const css = files.find((f) => /^app-[0-9a-f]{8}\.css$/.test(f));
  check('the bundle is built (run npm run build:web first)', Boolean(js && css && files.includes('index.html') && files.includes('manifest.webmanifest') && files.includes('icon.svg')), files);
  if (!js || !css) return { failures, count };
  const origin = `http://127.0.0.1:${port}`;

  async function open(url, width, extra = {}) {
    const page = await browser.newPage({ viewport: { width, height: 800 }, ...extra });
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
    page.errors = errors;
    // the fake-host shell makes real requests for Library and Notes; the invented server answers them (dev/web-fixtures.mjs)
    if (url.startsWith(`${origin}/dev/harness/web.html`)) {
      await useFixtures(page);
      // Settings asks the server for the phone link (dev/web-phone-checks.mjs covers it)
      await page.route('**/web/phone-link', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"problem":"Not set up in this harness."}' }));
    }
    if (process.env.SB_DEBUG) { page.on('console', (m) => console.log('  console', m.type(), m.text())); page.on('request', (r) => console.log('  >', r.method(), new URL(r.url()).pathname + new URL(r.url()).search)); }
    return { page, goto: () => page.goto(url) };
  }
  const noSideways = (page) => page.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth);
  const go = async (page, hash) => {
    await page.evaluate((h) => { location.hash = h; }, hash);
    await page.waitForTimeout(150);
  };

  // ------------------------------------------------------------ the shell on the fake host
  const fakeUrl = `${origin}/dev/harness/web.html?js=${encodeURIComponent(`/dist-web/${js}`)}&css=${encodeURIComponent(`/dist-web/${css}`)}`;
  for (const width of WIDTHS) {
    const { page, goto } = await open(fakeUrl, width);
    await goto();
    await page.waitForFunction(() => window.__sbWebReady === true, null, { timeout: 8000 });
    const tag = `${width}px`;

    // Home: today's radar issue across the full width with its papers in abstract form, then a shelf per kind, 8 a page
    await go(page, '#/home');
    await page.waitForSelector('.sbw-paper');
    const home = await page.evaluate(() => ({
      banner: (() => { const b = document.querySelector('.sbw-today-banner'); return { label: b.querySelector('.sbw-cover-label')?.textContent, title: b.querySelector('.sbw-cover-title')?.textContent, line: b.querySelector('.sbw-cover-line')?.textContent, fresh: b.classList.contains('is-new'), href: b.getAttribute('href'), chat: document.querySelector('.sbw-today-chat:not([hidden])')?.getAttribute('href') ?? null }; })(),
      papers: [...document.querySelectorAll('.sbw-paper')].map((p) => ({ source: p.querySelector('.sbw-paper-source')?.textContent ?? null, title: p.querySelector('.sbw-paper-title')?.textContent, href: p.querySelector('a.sbw-paper-title')?.getAttribute('href') ?? null, meta: p.querySelector('.sbw-paper-meta')?.textContent ?? null, why: p.querySelector('.sbw-paper-why')?.textContent ?? null })),
      heads: [...document.querySelectorAll('.sbw-papers-head')].map((x) => x.textContent),
      shelves: [...document.querySelectorAll('.sbw-shelf')].map((sh) => ({ title: sh.querySelector('.sbw-shelf-title')?.textContent, count: sh.querySelector('.sbw-shelf-count')?.textContent, covers: [...sh.querySelectorAll('.sbw-cover-title')].map((c) => c.textContent), pager: sh.querySelector('.sbw-pager-where')?.textContent ?? null })),
      count: document.querySelector('.sbw-home-date')?.textContent, badge: document.querySelector('.sbw-nav-item[data-view="home"] .sbw-nav-badge')?.textContent,
    }));
    const today = new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
    check(`${tag} Today leads across the full width: today's radar issue, dated, how many are new, marked new, its chat one link away (the banner itself is not a link)`, home.banner.label === "Today's reading radar" && home.banner.title === today && home.banner.line === '5 new papers' && home.banner.fresh && home.banner.href === null && home.banner.chat === '#/chat?session=c4', home.banner);
    check(`${tag} Today shows every paper in abstract form: the title to the paper, authors, venue and date, why read it`, home.papers.length === 3 && home.papers[0].title === 'Burrow microclimates in field voles' && home.papers[0].href === 'https://doi.org/10.1/vole' && home.papers[0].meta === 'A. Vole, B. Mole · Ecology · 2026-10-10' && home.papers[0].why === 'Burrows stay four degrees warmer than the surface.' && home.papers[1].why === 'Voles cache seeds under the snowpack.' && home.papers[2].why === 'Cited by 3 papers in your library' && JSON.stringify(home.heads) === '["Worth reading"]', home.papers);
    check(`${tag} the rest is separated into Research reports, Chats and Earlier issues, each counted`, JSON.stringify(home.shelves.map((x) => [x.title, x.count])) === '[["Research reports","1"],["Chats","10"],["Earlier issues","1"]]', home.shelves);
    await page.waitForSelector('.sbw-paper.has-figure');
    const figures = await page.evaluate(async () => {
      const papers = [...document.querySelectorAll('.sbw-paper')];
      const first = papers[0];
      const box = first.querySelector('.sbw-paper-figure-box')?.getBoundingClientRect();
      const text = first.querySelector('.sbw-paper-text').getBoundingClientRect();
      const more = first.querySelector('.sbw-paper-more');
      const summary = more?.querySelector('summary');
      const before = { label: summary?.textContent, shown: more ? more.querySelector('.sbw-paper-abstract').checkVisibility() : null };
      summary?.click();
      await new Promise((r) => setTimeout(r, 50));
      const after = { label: summary?.textContent, text: more?.querySelector('.sbw-paper-abstract')?.textContent ?? '', shown: more ? more.querySelector('.sbw-paper-abstract').checkVisibility() : null };
      summary?.click();
      return { withFigure: papers.map((p) => p.classList.contains('has-figure')), right: box ? box.left >= text.right && Math.abs(box.width / box.height - 4 / 3) < 0.02 : false, before, after };
    });
    check(`${tag} a paper with a graphical abstract shows it on the right in a 4:3 frame; the others have none`, JSON.stringify(figures.withFigure) === '[true,false,false]' && figures.right, figures);
    check(`${tag} "Read the abstract" opens the full abstract and "Show less" closes it`, figures.before.label === 'Read the abstract' && figures.before.shown === false && figures.after.label === 'Show less' && figures.after.shown === true && figures.after.text.endsWith('The end.'), figures);
    check(`${tag} each paper says where it was found`, home.papers[0].source === 'Found via bioRxiv, Ecology feed', home.papers[0]);
    const stepped = await page.evaluate(async () => {
      const wait = () => new Promise((r) => setTimeout(r, 80));
      const title = () => document.querySelector('.sbw-today-banner .sbw-cover-title')?.textContent;
      const papers = () => [...document.querySelectorAll('.sbw-paper-title')].map((t) => t.textContent);
      const older = document.querySelector('.sbw-today-older');
      const newer = document.querySelector('.sbw-today-newer');
      const start = { older: older.hidden ? null : older.textContent, newer: newer.hidden };
      older.click(); await wait();
      const back = { title: title(), label: document.querySelector('.sbw-today-banner .sbw-cover-label')?.textContent, papers: papers(), newer: newer.hidden ? null : newer.textContent, older: older.hidden };
      newer.click(); await wait();
      return { start, back, again: papers().length };
    });
    const yesterday = new Date(Date.now() - 26 * 3600_000);
    check(`${tag} ‹ steps back to the previous day's issue and its papers, Today › comes back`, stepped.start.older === `‹ ${yesterday.toLocaleDateString([], { month: 'short', day: 'numeric' })}` && stepped.start.newer && stepped.back.title === yesterday.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }) && stepped.back.label === 'Reading radar' && JSON.stringify(stepped.back.papers) === '["Yesterday in vole land"]' && stepped.back.newer === 'Today ›' && stepped.back.older && stepped.again === 3, stepped);
    const earlierHref = await page.evaluate(() => [...document.querySelectorAll('.sbw-shelf')].find((sh) => sh.querySelector('.sbw-shelf-title')?.textContent === 'Earlier issues')?.querySelector('.sbw-cover')?.getAttribute('href'));
    await go(page, earlierHref ?? '#/home');
    await page.waitForFunction(() => document.querySelector('.sbw-today-banner .sbw-cover-label')?.textContent === 'Reading radar');
    const earlier = await page.evaluate(() => ({ hash: location.hash, chat: document.querySelector('.sbw-today-chat:not([hidden])')?.getAttribute('href'), papers: [...document.querySelectorAll('.sbw-paper-title')].map((t) => t.textContent), inChat: !document.querySelector('.sbw-home') }));
    check(`${tag} an earlier issue opens on Home as a list like today's (#/home?issue=), with its chat one link away`, earlierHref?.startsWith('#/home?issue=') && earlier.hash === earlierHref && JSON.stringify(earlier.papers) === '["Yesterday in vole land"]' && earlier.chat === `#/chat?session=${earlierHref.split('=')[1]}` && !earlier.inChat, { earlierHref, earlier });
    await go(page, '#/home');
    await page.waitForSelector('.sbw-paper');
    check(`${tag} a research report gets its own cover in its own shelf`, JSON.stringify(home.shelves[0].covers) === '["What Voles Eat: A Review"]', home.shelves[0]);
    check(`${tag} Chats shows 8 a page, newest first, with "1 of 2"`, home.shelves[1].covers.length === 8 && JSON.stringify(home.shelves[1].covers.slice(0, 3)) === '["Foraging in voles","Voles weekly","Doorknob ergonomics"]' && home.shelves[1].pager === '1 of 2', home.shelves[1]);
    const paged = await page.evaluate(async () => {
      const shelf = [...document.querySelectorAll('.sbw-shelf')].find((x) => x.querySelector('.sbw-shelf-title')?.textContent === 'Chats');
      const prev = shelf.querySelector('.sbw-pager-prev');
      const next = shelf.querySelector('.sbw-pager-next');
      const before = { prev: prev.disabled, next: next.disabled };
      next.click();
      await new Promise((r) => setTimeout(r, 30));
      const after = { covers: [...shelf.querySelectorAll('.sbw-cover-title')].map((c) => c.textContent), where: shelf.querySelector('.sbw-pager-where').textContent, prev: prev.disabled, next: next.disabled };
      prev.click();
      return { before, after };
    });
    check(`${tag} Next shows the second page and Previous comes back`, paged.before.prev && !paged.before.next && paged.after.where === '2 of 2' && JSON.stringify(paged.after.covers) === '["Old vole question 6","Old vole question 7"]' && !paged.after.prev && paged.after.next, paged);
    check(`${tag} the new papers waiting are counted beside the greeting and on the Home rail item`, home.count === '8 new papers' && home.badge === '8', home);

    // Folio look: Fraunces headings, an even grid of photo covers, near-square corners, white text, a wide banner photo
    const look = await page.evaluate(async () => {
      await document.fonts.ready;
      const covers = [...document.querySelectorAll('.sbw-shelf .sbw-cover')];
      const rect = (el) => el.getBoundingClientRect();
      const report = document.querySelector('.sbw-cover.is-report');
      const banner = document.querySelector('.sbw-today-banner');
      return {
        h1: getComputedStyle(document.querySelector('.sbw-h1')).fontFamily, h1Size: parseFloat(getComputedStyle(document.querySelector('.sbw-h1')).fontSize),
        fraunces: document.fonts.check('32px Fraunces'), inter: document.fonts.check('15px Inter'), body: getComputedStyle(document.body).fontFamily, title: getComputedStyle(document.querySelector('.sbw-cover-title')).fontFamily,
        radius: Math.max(...covers.map((c) => parseFloat(getComputedStyle(c).borderTopLeftRadius))),
        colors: [...new Set(covers.map((c) => getComputedStyle(c).color))],
        widths: new Set(covers.map((c) => Math.round(rect(c).width))).size,
        reportPhoto: /cover-(sky|earth|wide)-\d\d\.webp/.exec(getComputedStyle(report).backgroundImage)?.[1] ?? null,
        chatPhotos: [...document.querySelectorAll('.sbw-cover.is-chat, .sbw-cover.is-find')].map((c) => getComputedStyle(c).backgroundImage),
        chatText: getComputedStyle(document.querySelector('.sbw-cover.is-chat .sbw-cover-title')).color,
        clamped: [...document.querySelectorAll('.sbw-cover-title, .sbw-paper-title')].filter((t) => t.scrollHeight > t.clientHeight + 1).length,
        bannerPhoto: /cover-(wide)-\d\d\.webp/.exec(getComputedStyle(banner).backgroundImage)?.[1] ?? null,
        bannerFull: Math.abs(rect(banner).width - rect(document.querySelector('.sbw-home-body')).width) <= 1,
        frame: getComputedStyle(report, '::before').borderTopWidth,
        lefts: [rect(document.querySelector('.sbw-h1')).left, rect(banner).left],
        buttons: document.querySelectorAll('.sb-button.is-primary').length,
      };
    });
    check(`${tag} Home headings are Fraunces, the page title at least 32 px`, look.fraunces && /^"?Fraunces\b/.test(look.h1) && /^"?Fraunces\b/.test(look.title) && look.h1Size >= 32, look);
    check(`${tag} the interface font is Inter`, look.inter && /^"?Inter\b/.test(look.body), look.body);
    check(`${tag} covers: one width, radius 2, no filled button, every title shown in full`, look.widths === 1 && look.radius === 2 && look.buttons === 0 && look.clamped === 0, look);
    const columns = await page.evaluate(() => ({
      cols: getComputedStyle(document.querySelector('.sbw-papers')).gridTemplateColumns.split(' ').length,
      switch: document.querySelectorAll('.sbw-layout-btn[data-columns]').length,
      width: Math.round(document.querySelector('.sbw-today').getBoundingClientRect().width),
    }));
    check(`${tag} two columns only when the issue is at least 960 px wide, and no column switch on Home (it is in Settings)`, columns.switch === 0 && columns.cols === (columns.width >= 960 ? 2 : 1), columns);
    check(`${tag} the banner spans the page with a wide photo; the report has a research photo and a hairline frame; chats are text cards with no photo`, look.bannerFull && look.bannerPhoto === 'wide' && look.reportPhoto === 'earth' && look.frame === '1px' && look.chatPhotos.every((p) => p === 'none') && look.chatText !== 'rgb(255, 255, 255)', look);
    check(`${tag} the page title and the banner share a left edge`, Math.abs(look.lefts[0] - look.lefts[1]) <= 1, look.lefts);
    const loaded = await page.evaluate(async () => {
      const url = /url\("?([^")]+)"?\)/.exec(getComputedStyle(document.querySelector('.sbw-today-banner')).backgroundImage)?.[1];
      const img = new Image();
      img.src = url;
      return new Promise((resolve) => { img.onload = () => resolve(img.naturalWidth); img.onerror = () => resolve(0); });
    });
    check(`${tag} the banner photo loads at banner size`, loaded >= 1600, loaded);

    // one click between light and dark: the rail button from 700 px, a More menu item on the phone
    const flip = await page.evaluate(async () => {
      const wide = innerWidth >= 700;
      const control = document.querySelector(wide ? '.sbw-theme' : '.sbw-menu-item.is-phone-only[type="button"]');
      const visible = control.getBoundingClientRect().width > 0 || !wide;
      const before = { theme: document.documentElement.getAttribute('data-theme'), bg: getComputedStyle(document.body).backgroundColor, label: control.textContent };
      control.click();
      await new Promise((r) => setTimeout(r, 50));
      const after = { theme: document.documentElement.getAttribute('data-theme'), bg: getComputedStyle(document.body).backgroundColor, label: control.textContent };
      control.click();
      await new Promise((r) => setTimeout(r, 50));
      return { visible, before, after, back: document.documentElement.getAttribute('data-theme') };
    });
    check(`${tag} the theme switch flips light and dark and relabels itself`, flip.visible && flip.after.theme !== flip.back && ['light', 'dark'].includes(flip.after.theme) && flip.before.bg !== flip.after.bg && flip.before.label !== flip.after.label, flip);

    // a conversation opens in the chat
    await page.locator('.sbw-cover', { hasText: 'Foraging in voles' }).click();
    await page.waitForSelector('.sb-ai-answer .sb-ai-md');
    const opened = await page.evaluate(() => ({ hash: location.hash, text: document.querySelector('.sb-ai-thread')?.textContent ?? '' }));
    check(`${tag} a Home conversation opens the chat on that session`, opened.hash === '#/chat?session=c1' && opened.text.includes('Seeds and roots.'), opened);

    // a turn through the fake engine
    if (width >= 700) {
      await page.fill('.sb-ai-input', 'Tell me about voles');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => [...document.querySelectorAll('.sb-ai-answer')].some((t) => t.textContent.includes('Echo: Tell me about voles')), null, { timeout: 5000 });
      check(`${tag} a chat message gets its answer`, true);
    }

    // every route renders, one ChatView only, and the page never scrolls sideways
    for (const route of ROUTES) {
      await go(page, `#/${route}`);
      const state = await page.evaluate(() => ({
        chats: document.querySelectorAll('.sb-ai').length,
        pageVisible: !document.querySelector('.sbw-view-page').hidden,
        chatVisible: !document.querySelector('.sbw-view-chat').hidden,
        text: (document.querySelector('.sbw-view:not([hidden])')?.innerText ?? '').length,
        active: document.querySelector('.sbw-nav-item.is-active')?.dataset.view ?? (document.querySelector('.sbw-more.is-active') ? 'settings' : null),
      }));
      const inChat = route === 'chat' || route === 'routines';
      check(`${tag} #/${route} renders`, state.chats <= 1 && state.chatVisible === inChat && state.pageVisible === !inChat && state.text > 0, state);
      check(`${tag} #/${route} has no sideways page scroll`, await noSideways(page));
      // Routines moved into Settings: its page lights the More item, like Settings does
      check(`${tag} #/${route} marks its rail item`, state.active === (route === 'routines' ? 'settings' : route), state.active);
    }

    await go(page, '#/routines');
    await page.waitForSelector('.sb-rt-card');
    const card = await page.evaluate(() => document.querySelector('.sb-rt-card')?.textContent ?? '');
    check(`${tag} Routines lists the routine`, card.includes('Voles weekly') && card.includes('3 new'), card);

    await go(page, '#/projects');
    await page.waitForSelector('.sbw-card');
    check(`${tag} Projects lists the project`, (await page.locator('.sbw-card').first().textContent()).includes('Voles'));

    // exactly one ChatView after moving around, and its hash follows the mode
    await go(page, '#/chat?mode=find');
    const mode = await page.evaluate(() => ({ chats: document.querySelectorAll('.sb-ai').length, mode: window.__shell.chat.mode }));
    check(`${tag} a mode in the route switches the one chat`, mode.chats === 1 && mode.mode === 'find', mode);

    // the ellipsis menu reaches Settings and Search index
    await page.locator('.sbw-more').click();
    // below 700 px the bar has no room for Routines and Projects, so More lists them first (ledger 12)
    const menuItems = await page.evaluate(() => [...document.querySelectorAll('.sbw-menu-item')].filter((n) => getComputedStyle(n).display !== 'none').map((n) => n.textContent));
    check(`${tag} the ellipsis menu lists ${width < 700 ? 'the theme switch, Projects, ' : ''}Settings and Search index (Routines and the radar are in Settings)`, JSON.stringify(menuItems) === JSON.stringify([...(width < 700 ? [menuItems[0], 'Projects'] : []), 'Settings', 'Search index']) && (width >= 700 || /^(Light|Dark) mode$/.test(menuItems[0])), menuItems);
    await page.locator('.sbw-menu-item', { hasText: 'Search index' }).click();
    await page.waitForSelector('.sbw-row');
    check(`${tag} Search index shows the index`, (await page.locator('#sbw-index').textContent()).includes('40 documents'));

    // Settings > Folders (server spec 018 G4): the list with kind and count, then add, switch off and remove
    await go(page, '#/settings?section=folders');
    await page.waitForSelector('#sbw-folders .sbw-folder');
    const folderRows = await page.evaluate(() => [...document.querySelectorAll('#sbw-folders .sbw-folder')].map((r) => `${r.querySelector('.sbw-row-name').textContent}: ${r.querySelector('.sbw-row-detail').textContent}`));
    check(`${tag} Folders lists the vault, Zotero and the plain folder with kind and count`, JSON.stringify(folderRows) === JSON.stringify([
      'second-brain: Obsidian vault · 40 documents · main folder: notes Second Brain writes go here',
      'zotero: Zotero library · 12 documents', 'papers: Folder · 7 documents']), folderRows);
    check(`${tag} Folders: no sideways page scroll`, await noSideways(page));
    if (width === 1280) {
      const form = page.locator('.sbw-folders-add');
      const folderRow = (name) => page.locator('.sbw-folder').filter({ has: page.locator('.sbw-row-name', { hasText: new RegExp(`^${name}$`) }) });
      await form.locator('input').first().fill('relative/notes');
      await form.locator('button').click();
      await page.waitForFunction(() => document.querySelector('#sbw-folders .sbw-hint')?.textContent.includes('full path'));
      check(`${tag} a bad path shows the server's reason`, true);
      // that 400 was asked for: the browser logs it, the shell itself did nothing wrong
      page.errors.splice(0, page.errors.length, ...page.errors.filter((e) => !e.includes('status of 400')));
      await form.locator('input').first().fill('/Users/me/Projects/Notes');
      await form.locator('button').click();
      await page.waitForFunction(() => document.querySelectorAll('#sbw-folders .sbw-folder').length === 4);
      check(`${tag} Add folder adds a row and says so`, (await page.locator('#sbw-folders .sbw-hint').textContent()).startsWith('Added notes'));
      await folderRow('papers').locator('input[type=checkbox]').uncheck();
      await page.waitForFunction(() => [...document.querySelectorAll('.sbw-folder')].some((r) => r.classList.contains('is-off') && r.textContent.includes('papers')));
      check(`${tag} switching a folder off marks it off`, true);
      page.once('dialog', (dialog) => void dialog.accept());
      await folderRow('notes').getByRole('button', { name: 'Remove' }).click();
      await page.waitForFunction(() => document.querySelectorAll('#sbw-folders .sbw-folder').length === 3);
      await folderRow('papers').locator('input[type=checkbox]').check();
      await page.waitForFunction(() => [...document.querySelectorAll('.sbw-folder')].some((r) => r.classList.contains('is-listed') && r.textContent.includes('papers')));
      check(`${tag} Remove asks first and takes the row away`, true);
    }

    // Home: each paper of the issue can be rated where it is read (Add to Zotero or Read later, Like, Dislike), with Undo
    await go(page, '#/home');
    await page.waitForSelector('.sbw-paper .sb-dg-acts .sb-dg-act');
    const acts = await page.evaluate(() => [...document.querySelectorAll('.sbw-paper')].map((p) => [...p.querySelectorAll('.sb-dg-act')].map((b) => b.textContent)));
    check(`${tag} Home: every paper of the issue has the radar's actions`, acts.length >= 2 && acts.every((a) => a.length === 3 && (a[0] === 'Add to Zotero' || a[0] === 'Read later') && a[1] === 'Like' && a[2] === 'Dislike'), acts);
    const rows = await page.evaluate(() => [...document.querySelectorAll('.sbw-paper .sb-dg-acts')].map((box) => new Set([...box.querySelectorAll('.sb-dg-act')].map((b) => Math.round(b.getBoundingClientRect().top))).size));
    check(`${tag} Home: each paper's actions fit on one line`, rows.every((n) => n === 1), rows);
    if (width === 1280) {
      // under each paper: the AI summary (default) or the abstract, remembered
      const firstLine = () => page.locator('.sbw-paper .sbw-paper-why').first().textContent();
      check(`${tag} Home: the AI summary is shown by default`, (await firstLine()) === 'Burrows stay four degrees warmer than the surface.');
      await page.locator('.sbw-layout-btn', { hasText: 'Abstract' }).click();
      await page.waitForFunction(() => document.querySelector('.sbw-paper .sbw-paper-why')?.textContent.startsWith('Field voles dig burrows'));
      check(`${tag} Home: Abstract shows each paper's abstract instead, justified`, (await page.evaluate(() => getComputedStyle(document.querySelector('.sbw-paper .sbw-paper-why')).textAlign)) === 'justify');
      await page.locator('.sbw-layout-btn', { hasText: 'AI summary' }).click();
      await page.waitForFunction(() => document.querySelector('.sbw-paper .sbw-paper-why')?.textContent.startsWith('Burrows stay'));
      const first = page.locator('.sbw-paper').first();
      await first.getByRole('button', { name: 'Dislike' }).click();
      await page.waitForFunction(() => document.querySelector('.sbw-paper')?.classList.contains('is-dismissed'));
      const fb = await page.evaluate(() => window.__store.feedback ?? []);
      check(`${tag} Home: Dislike tells the radar and greys the paper`, JSON.stringify(fb.at(-1)) === JSON.stringify({ routineId: 'r2', key: 'doi:10.1/vole', verdict: 'dismissed' }) && (await first.locator('.sb-dg-state').textContent()) === 'Disliked', fb);
      await first.getByRole('button', { name: 'Undo' }).click();
      await page.waitForFunction(() => !document.querySelector('.sbw-paper')?.classList.contains('is-dismissed'));
      check(`${tag} Home: Undo puts it back`, (await page.evaluate(() => window.__store.feedback.at(-1).verdict)) === 'undo');
    }

    // Library: on a wide screen the collections column folds away, like the chat history, and stays folded
    if (width >= 700) {
      await go(page, '#/library');
      await page.waitForSelector('.sbw-lib-tree');
      await page.locator('.sbw-lib-collections').click();
      const folded = await page.evaluate(() => getComputedStyle(document.querySelector('.sbw-lib-tree')).display);
      await go(page, '#/home');
      await go(page, '#/library');
      await page.waitForSelector('.sbw-lib');
      const still = await page.evaluate(() => getComputedStyle(document.querySelector('.sbw-lib-tree')).display);
      await page.locator('.sbw-lib-collections').click();
      const back = await page.evaluate(() => getComputedStyle(document.querySelector('.sbw-lib-tree')).display);
      check(`${tag} Library: Collections folds the column away, remembers it, and brings it back`, folded === 'none' && still === 'none' && back === 'block', { folded, still, back });
    }

    // wording: the web host never names Zotero or Obsidian as the place papers and notes live
    await go(page, '#/chat?mode=find');
    const words = await page.evaluate(() => ({
      pills: [...document.querySelectorAll('.sb-ai-source')].map((b) => b.title).join(' | '),
      empty: document.querySelector('.sb-ai-empty-text')?.textContent ?? '',
    }));
    check(`${tag} source pills and the Find empty state read host-neutral`, !/Zotero|Obsidian/i.test(`${words.pills} ${words.empty}`) && /library/i.test(words.pills), words);
    if (width === 1280) await page.screenshot({ path: join(outDir, 'web-shell-1280.png') });
    if (width === 360) await page.screenshot({ path: join(outDir, 'web-shell-360.png') });
    check(`${tag} the shell logged no errors`, page.errors.length === 0, page.errors);
    await page.close();
  }


  // ------------------------------------------------------------ a server that cannot list routines is not "no radar"
  {
    const { page, goto } = await open(`${fakeUrl}&routines=fail`, 1280);
    await goto();
    await page.waitForFunction(() => window.__sbWebReady === true, null, { timeout: 8000 });
    await go(page, '#/home');
    await page.waitForSelector('.sbw-today');
    const seen = await page.evaluate(() => ({ setup: document.body.textContent.includes('Set up a reading radar'), intro: Boolean(document.querySelector('.sbw-sources.is-intro')), hint: document.querySelector('.sbw-today')?.textContent ?? '' }));
    check('1280px Home: routines that fail to load do not read as "no radar"', !seen.setup && !seen.intro && /Couldn't read your reading radar/.test(seen.hint) || (!seen.setup && !seen.intro), seen);
    await page.close();
  }

  // ------------------------------------------------------------ seed papers in the radar's onboarding (server spec 021 G1)
  for (const width of WIDTHS) {
    const { page, goto } = await open(`${fakeUrl}&routines=none`, width);
    await goto();
    await page.waitForFunction(() => window.__sbWebReady === true, null, { timeout: 8000 });
    const tag = `${width}px seeds`;
    await go(page, '#/sources');
    await page.waitForSelector('.sbw-seeds-mine');
    const count = () => page.locator('.sbw-seeds-count').textContent();
    const start = { h2: await page.locator('.sbw-seeds-h2').allTextContents(), count: await count() };
    check(`${tag}: the page starts from your papers, then more like these, with no seeds until one is picked`, JSON.stringify(start.h2) === '["Your papers","More papers like these"]' && start.count === 'No seed papers yet.', start);
    await page.locator('.sbw-seeds-mine input[aria-label="Your name"]').fill('Ada Burrow');
    await page.locator('.sbw-seeds-mine').getByRole('button', { name: 'Find my papers' }).click();
    await page.waitForSelector('.sbw-seeds-mine .sbw-seeds-paper');
    const listed = await page.evaluate(() => [...document.querySelectorAll('.sbw-seeds-mine .sbw-seeds-paper')].map((li) => [li.querySelector('.sbw-seeds-title').textContent, li.querySelector('input').checked, li.querySelector('.sbw-seeds-meta').textContent]));
    check(`${tag}: your papers are listed, usable ones ticked, each saying whether it is in the library`, JSON.stringify(listed) === JSON.stringify([
      ['Vole foraging under snow', true, '2025 · in your library'], ['Burrow temperature in winter', true, '2024 · in your library'],
      ['Seed caches of field voles', true, '2023 · not in your library; its abstract is used'], ['A conference poster', false, '2022 · not in your library and no abstract; it cannot be used']]), listed);
    check(`${tag}: namesakes can be told apart`, (await page.locator('.sbw-seeds-who select option').count()) === 2 && (await count()) === '3 seed papers');
    await page.locator('.sbw-seeds-mine .sbw-seeds-paper', { hasText: 'Burrow temperature' }).locator('input').uncheck();
    check(`${tag}: unticking updates the count and says 3 are needed`, (await count()) === '2 seed papers (at least 3 needed)');
    check(`${tag}: no sideways page scroll`, await noSideways(page));
    if (width === 1280) {
      await page.locator('.sbw-seeds-more input[aria-label="Search your library for seed papers"]').fill('gauge');
      await page.locator('.sbw-seeds-more').getByRole('button', { name: 'Search' }).click();
      await page.waitForSelector('.sbw-seeds-more .sbw-seeds-add');
      await page.locator('.sbw-seeds-more .sbw-seeds-add').first().click();
      await page.waitForFunction(() => document.querySelector('.sbw-seeds-count')?.textContent === '3 seed papers');
      check(`${tag}: a library paper found by search joins the seeds as a chip`, (await page.locator('.sbw-seeds-picked .sbw-chip').count()) === 1);
      await page.locator('.sbw-src-save').click();
      await page.waitForFunction(() => /Keeping papers at least 0\.77/.test(document.querySelector('.sbw-src-status')?.textContent ?? ''), null, { timeout: 8000 });
      const got = await page.evaluate(() => ({ prepared: window.__store.prepared ?? [], save: (window.__store.saves ?? []).at(-1)?.draft?.radar ?? null }));
      const r = got.save;
      check(`${tag}: saving calibrates once and says the threshold and categories`, /arXiv categories: q-bio\.PE/.test(await page.locator('.sbw-src-status').textContent()) && got.prepared.length === 1, got.prepared);
      check(`${tag}: the saved radar carries its seeds, the calibrated threshold, 15 a day and arXiv on`,
        r && r.seeds.mine.map((m) => m.title).join('|') === 'Vole foraging under snow|Seed caches of field voles' && r.seeds.papers.length === 1 && r.seeds.categories[0] === 'q-bio.PE'
        && r.threshold.abstract === 0.77 && r.size.fresh === 15 && r.sources.some((x) => x.id === 'database:arxiv' && x.on), r);
      await page.screenshot({ path: join(outDir, 'web-seeds-1280.png'), fullPage: true });
    }
    check(`${tag}: no page errors`, page.errors.length === 0, page.errors);
    await page.close();
  }

  // ------------------------------------------------------------ Connect guide, keys kept hidden (server spec 020 G3)
  for (const width of WIDTHS) {
    const { page, goto } = await open(fakeUrl, width);
    await goto();
    await page.waitForFunction(() => window.__sbWebReady === true, null, { timeout: 8000 });
    const tag = `${width}px connect`;
    await go(page, '#/settings?section=sources');
    const more = page.locator('.sbs-advanced');
    if (await more.count() && !(await more.first().locator('input').isChecked())) await more.first().click();  // the switch's input is hidden behind its track
    const catalog = page.locator('.sbs-mcp-catalog:not(.sbs-mcp-own)');
    await catalog.locator('summary').click();
    const exa = catalog.locator('.sbs-mcp-entry', { hasText: 'Exa' });
    check(`${tag}: a keyed source offers Connect, a keyless one Add`, (await exa.getByRole('button').textContent()) === 'Connect'
      && (await catalog.locator('.sbs-mcp-entry', { hasText: 'ChEMBL' }).getByRole('button').textContent()) === 'Add');
    await exa.getByRole('button', { name: 'Connect' }).click();
    const guide = page.locator('.sbs-guide[aria-label="Connect Exa"]');
    await guide.waitFor();
    const steps = await guide.locator('.sbs-guide-step > .sbs-label').allTextContents();
    check(`${tag}: the guide walks through what it gives, getting the key, pasting it`, JSON.stringify(steps) === JSON.stringify(['What it gives you', 'Get the key', 'Paste it here'])
      && (await guide.locator('input').getAttribute('type')) === 'password' && (await guide.locator('.sbs-guide-open').textContent()) === 'Open dashboard.exa.ai', steps);
    check(`${tag}: no sideways page scroll with the guide open`, await noSideways(page));
    if (width === 1280) {
      await guide.getByRole('button', { name: 'Connect and test' }).click();
      await page.waitForFunction(() => document.querySelector('.sbs-guide-status')?.textContent === 'Fill in: Exa API key.');
      check(`${tag}: an empty required key is asked for`, true);
      await guide.locator('input').fill('exa-bad-key-0000');
      await guide.getByRole('button', { name: 'Connect and test' }).click();
      await page.waitForFunction(() => document.querySelector('.sbs-guide-status')?.textContent.startsWith('The key was refused'));
      check(`${tag}: a refused key says so in plain words and the field is cleared`, (await guide.locator('input').inputValue()) === '');
      await guide.locator('input').fill('exa-key-12345678');
      await guide.getByRole('button', { name: 'Connect and test' }).click();
      await page.waitForFunction(() => /^Connected · 2 usable tools/.test(document.querySelector('.sbs-guide-status')?.textContent ?? ''));
      const saved = await page.evaluate(() => window.__mcpSaved.exa.headers.Authorization);
      check(`${tag}: the key is saved with its Bearer prefix`, saved === 'Bearer exa-key-12345678', saved);
      const item = page.locator('.sbs-mcp-item', { hasText: 'exa' });
      await item.locator('.sbs-mcp-keyline').waitFor();
      check(`${tag}: the added source shows the key as saved, never the key`, (await item.locator('.sbs-mcp-keyline .sbs-help').textContent()) === 'Key saved (•••• 5678)'
        && !(await page.content()).includes('exa-key-12345678'));
      // Trust it round-trips the hidden config: the key must survive
      await item.locator('.sbs-mcp-trust input').check();
      await page.waitForTimeout(300);
      check(`${tag}: changing Trust it keeps the key`, await page.evaluate(() => window.__mcpSaved.exa.headers.Authorization === 'Bearer exa-key-12345678' && window.__mcpSaved.exa.trustUnmarked === true));
      // Replace key with the field left empty keeps it
      await item.getByRole('button', { name: 'Replace key' }).click();
      await item.locator('.sbs-guide').getByRole('button', { name: 'Connect and test' }).click();
      await page.waitForFunction(() => window.__mcpSaved.exa && document.querySelectorAll('.sbs-guide-status.is-good').length > 0);
      check(`${tag}: Replace key with nothing typed keeps the saved key`, await page.evaluate(() => window.__mcpSaved.exa.headers.Authorization === 'Bearer exa-key-12345678'));
      // Add your own: an address and a key
      const own = page.locator('.sbs-mcp-own');
      await own.locator('summary').click();
      const fields = own.locator('input');
      await fields.nth(0).fill('My Search');
      await fields.nth(1).fill('https://search.example/mcp');
      await fields.nth(2).fill('own-key-abcdefgh');
      await own.getByRole('button', { name: 'Connect and test' }).click();
      await page.waitForFunction(() => window.__mcpSaved['my-search']);
      const ownSaved = await page.evaluate(() => window.__mcpSaved['my-search']);
      check(`${tag}: Add your own saves an address with its key as a Bearer header`, ownSaved.transport === 'http' && ownSaved.url === 'https://search.example/mcp' && ownSaved.headers.Authorization === 'Bearer own-key-abcdefgh', ownSaved);
      await page.screenshot({ path: join(outDir, 'web-connect-1280.png'), fullPage: true });
    }
    check(`${tag}: no page errors`, page.errors.length === 0, page.errors);
    await page.close();
  }

  // ------------------------------------------------------------ building the index (server spec 019 G2)
  const RUNNING = { coverage: [{ source: 'personal', documents: 40 }], running: true, indexing: {
    running: true, stage: 'embedding', label: 'Making notes searchable by meaning', done: 22784, total: 82949, eta_seconds: 3013,
    stages: [
      { name: 'notes', label: 'Checking notes', state: 'done', done: 468, total: 468 },
      { name: 'media', label: 'Reading PDFs and images', state: 'done', done: 6, total: 6 },
      { name: 'zotero', label: 'Reading Zotero', state: 'skipped', done: 0, total: 0 },
      { name: 'embedding', label: 'Making notes searchable by meaning', state: 'running', done: 22784, total: 82949 }] } };
  for (const width of WIDTHS) {
    const { page, goto } = await open(fakeUrl, width);
    await page.addInitScript((status) => { window.__status = status; }, RUNNING);
    await goto();
    await page.waitForFunction(() => window.__sbWebReady === true, null, { timeout: 8000 });
    const tag = `${width}px progress`;
    await page.waitForSelector('.sbw-header-progress:not([hidden]) .sbw-progress-fill');
    const header = await page.evaluate(() => { const a = document.querySelector('.sbw-header-progress'); return { href: a.getAttribute('href'), title: a.title, width: a.querySelector('.sbw-progress-fill').style.width }; });
    check(`${tag}: the header bar shows while a build runs, with the line as its tooltip and a link to Search index`,
      header.href === '#/settings?section=index' && header.title === 'Making notes searchable by meaning · 22,784 of 82,949 · about 50 min left' && header.width === '27.5%', header);
    for (const section of ['index', 'folders']) {
      await go(page, `#/settings?section=${section}`);
      await page.waitForSelector('.sbw-progress.is-running .sbw-progress-fill');
      const panel = await page.evaluate(() => { const p = document.querySelector('.sbw-progress'); return {
        line: p.querySelector('.sbw-progress-line').textContent, width: p.querySelector('.sbw-progress-fill').style.width,
        now: p.querySelector('[role=progressbar]').getAttribute('aria-valuenow'),
        stages: [...p.querySelectorAll('.sbw-progress-stage')].map((li) => `${li.className.replace('sbw-progress-stage ', '')}:${li.textContent}`),
        stop: !p.querySelector('button').hidden }; });
      check(`${tag}: ${section} shows the stage bar, its line, every stage and Stop`,
        panel.line === 'Making notes searchable by meaning · 22,784 of 82,949 · about 50 min left' && panel.width === '27.5%' && panel.now === '27'
        && JSON.stringify(panel.stages) === JSON.stringify(['is-done:✓Checking notes', 'is-done:✓Reading PDFs and images', 'is-skipped:–Reading Zotero', 'is-running:…Making notes searchable by meaning']) && panel.stop, panel);
      check(`${tag}: ${section} has no sideways page scroll`, await noSideways(page));
    }
    if (width === 1280) {
      await page.locator('.sbw-progress button', { hasText: 'Stop' }).click();
      await page.waitForFunction(() => window.__stopped === 1);
      check(`${tag}: Stop asks the server to stop`, true);
      await page.screenshot({ path: join(outDir, 'web-progress-1280.png') });
    }
    // the build finishes: the next poll (2 s while running) hides the header bar, and the panel says so
    await page.evaluate(() => { window.__status = { coverage: [], running: false, indexing: { running: false, stage: 'idle', label: 'Up to date', finished_at: 1792540000, stages: [] } }; });
    await page.waitForSelector('.sbw-header-progress[hidden]', { state: 'attached', timeout: 5000 });
    await go(page, '#/settings?section=index');
    await page.waitForFunction(() => document.querySelector('.sbw-progress-line')?.textContent.startsWith('Up to date · last built'));
    check(`${tag}: when the build is done the header bar goes and the panel says Up to date`, await page.evaluate(() => !document.querySelector('.sbw-progress .sbw-progress-fill') && document.querySelector('.sbw-progress button').hidden && document.querySelector('.sbw-header-progress').hidden));
    check(`${tag}: no page errors`, page.errors.length === 0, page.errors);
    await page.close();
  }

  // ------------------------------------------------------------ Sources: who and what to follow (spec 014 G1)
  for (const width of WIDTHS) {
    const tag = `${width}px`;
    const chip = (page, group, label) => page.locator(`.sbw-src-group[data-group="${group}"] .sbw-chip`, { hasText: label });
    const ringCount = (page) => page.locator('.sbw-src-ring-n').textContent();
    const shot = (page, name) => page.screenshot({ path: join(outDir, `web-sources-${name}-${width}.png`), fullPage: true });

    // a fresh data folder: Home opens on the question, with nothing followed yet
    {
      const { page, goto } = await open(`${fakeUrl}&routines=none`, width);
      await goto();
      await page.waitForFunction(() => window.__sbWebReady === true, null, { timeout: 8000 });
      await go(page, '#/home');
      await page.waitForSelector('.sbw-sources.is-intro .sbw-chip');
      const first = await page.evaluate(async () => {
        await document.fonts.ready;
        const title = document.querySelector('.sbw-src-title');
        return {
          text: title.textContent, ems: [...title.querySelectorAll('em')].map((e) => [e.textContent, getComputedStyle(e).fontStyle]), font: getComputedStyle(title).fontFamily,
          groups: [...document.querySelectorAll('.sbw-src-group .sbw-src-h2')].map((x) => x.textContent), ring: document.querySelector('.sbw-src-ring-n').textContent,
          suggestion: document.querySelector('.sbw-src-suggest-text').textContent, explainer: document.querySelector('.sbw-src-explain')?.children.length ?? 0,
          lefts: [document.querySelector('.sbw-h1').getBoundingClientRect().left, document.querySelector('.sbw-src-title').getBoundingClientRect().left, document.querySelector('.sbw-src-title').getBoundingClientRect().right, document.querySelector('.sbw-home-body').getBoundingClientRect().right, document.querySelector('.sbw-src-hero').getBoundingClientRect().right],
          today: Boolean(document.querySelector('.sbw-today-banner')), shelves: document.querySelectorAll('.sbw-shelf').length,
          chipsPerGroup: [...document.querySelectorAll('.sbw-src-group')].map((g) => [g.dataset.group, g.querySelectorAll('.sbw-chip').length, g.querySelectorAll('.sbw-chip[aria-pressed="true"]').length]),
        };
      });
      check(`${tag} first run: Home opens on the Sources question, not on an empty Today`, first.text === 'The more you follow, the richer your radar gets.' && !first.today && first.shelves >= 1, first);
      check(`${tag} the headline is Fraunces with "more" and "richer" in italics`, /^"?Fraunces\b/.test(first.font) && JSON.stringify(first.ems) === '[["more","italic"],["richer","italic"]]', first);
      check(`${tag} five groups, nothing followed yet, the ring at 0, and the top half only (no explainer)`, JSON.stringify(first.groups) === '["Topics and keywords","Authors","Journals","Feeds","Databases"]' && first.ring === '0' && first.explainer === 0 && first.chipsPerGroup.every(([, , on]) => on === 0), first);
      check(`${tag} the suggestion is the library's most-cited journal`, first.suggestion === 'Follow Journal of Invented Zoology, the journal your library cites most.', first.suggestion);
      check(`${tag} the groups hold the library's suggestions and the seven databases`, JSON.stringify(first.chipsPerGroup.map(([g, n]) => [g, n])) === '[["topics",3],["authors",2],["journals",2],["feeds",0],["databases",7]]', first.chipsPerGroup);
      check(`${tag} first run lines up with the greeting and spans the page`, Math.abs(first.lefts[0] - first.lefts[1]) <= 1 && Math.abs(first.lefts[3] - first.lefts[4]) <= 1, first.lefts);
      check(`${tag} first run has no sideways scroll`, await noSideways(page));
      if (width === 1280) await shot(page, 'intro');

      // follow 2 topics, 1 author, 1 journal and 1 feed: the ring counts 5
      await chip(page, 'topics', 'vole foraging behaviour').click();
      await chip(page, 'topics', 'seed hoarding').click();
      await chip(page, 'authors', 'A. Bramblewood').click();
      await chip(page, 'journals', 'Journal of Invented Zoology').click();
      const afterChips = { ring: await ringCount(page), pressed: await chip(page, 'topics', 'seed hoarding').getAttribute('aria-pressed'), mark: await chip(page, 'topics', 'seed hoarding').locator('.sbw-chip-mark svg').count(), suggestion: await page.locator('.sbw-src-suggest-text').textContent() };
      check(`${tag} a chip toggles + to check and the ring counts it`, afterChips.ring === '4' && afterChips.pressed === 'true' && afterChips.mark === 1, afterChips);
      check(`${tag} the suggestion moves on once it is followed`, afterChips.suggestion === 'Follow C. Quills, the author your library cites most.', afterChips.suggestion);
      await chip(page, 'topics', 'seed hoarding').click();
      check(`${tag} a second click unfollows`, (await ringCount(page)) === '3' && (await chip(page, 'topics', 'seed hoarding').getAttribute('aria-pressed')) === 'false');
      await chip(page, 'topics', 'burrow ecology').click();
      await page.fill('.sbw-src-group[data-group="feeds"] .sbw-src-input', 'https://good.example/rss');
      await page.keyboard.press('Enter');
      await page.waitForSelector('.sbw-src-group[data-group="feeds"] .sbw-chip');
      const withFeed = { ring: await ringCount(page), feed: await page.locator('.sbw-src-group[data-group="feeds"] .sbw-chip-label').allTextContents(), note: await page.locator('.sbw-src-group[data-group="feeds"] .sbw-src-note').textContent() };
      check(`${tag} a pasted feed address is checked, added as a chip and followed`, withFeed.ring === '5' && JSON.stringify(withFeed.feed) === '["Good feed"]' && withFeed.note === 'Following Good feed.', withFeed);
      check(`${tag} the page has no sideways scroll with five followed`, await noSideways(page));

      // typing a topic and a journal ISSN
      await page.fill('.sbw-src-group[data-group="topics"] .sbw-src-input', '  vole   dispersal ');
      await page.keyboard.press('Enter');
      await page.fill('.sbw-src-group[data-group="journals"] .sbw-src-input', '1234-5678');
      await page.keyboard.press('Enter');
      await page.waitForSelector('.sbw-src-group[data-group="journals"] .sbw-chip.is-on:has-text("Invented Materials")');
      const typed = { ring: await ringCount(page), topics: await page.locator('.sbw-src-group[data-group="topics"] .sbw-chip.is-on .sbw-chip-label').allTextContents() };
      check(`${tag} a typed topic and a journal ISSN are added and followed`, typed.ring === '7' && typed.topics.includes('vole dispersal'), typed);
      await chip(page, 'journals', 'Invented Materials').click();
      await chip(page, 'topics', 'vole dispersal').click();
      check(`${tag} unfollowing them brings the ring back to 5`, (await ringCount(page)) === '5');

      await page.click('.sbw-src-save');
      await page.waitForSelector('.sbw-today-banner');
      const saved = await page.evaluate(() => ({ saves: window.__store.saves, intro: Boolean(document.querySelector('.sbw-sources')), done: window.__host.prefs.get('sourcesIntroDone') }));
      const draft = saved.saves?.[0]?.draft;
      const radar = draft?.radar;
      check(`${tag} Start my radar creates the radar with exactly what was followed`,
        saved.saves?.length === 1 && saved.saves[0].kind === 'create' && draft.kind === 'radar'
        && JSON.stringify(radar.profile.topics.map((t) => t.text)) === '["vole foraging behaviour","burrow ecology"]'
        && JSON.stringify(radar.profile.authors.map((a) => a.name)) === '["A. Bramblewood"]'
        && JSON.stringify(radar.profile.journals.map((a) => a.name)) === '["Journal of Invented Zoology"]'
        && JSON.stringify(radar.sources.filter((s) => s.on).map((s) => s.id).sort()) === '["author:A1","feed:https://good.example/rss","journal:S1"]'
        && radar.sources.filter((s) => s.kind === 'database').every((s) => !s.on)
        && radar.size.discover === 3 && !saved.intro && saved.done === true, saved);
      let accepted = null;
      try { validateDraft(draft); accepted = true; } catch (e) { accepted = String(e); }
      check(`${tag} the engine's own validation accepts what was saved`, accepted === true, accepted);
      const sheet = formFromRoutine(saved.saves[0].draft);
      check(`${tag} the setup sheet reads the same radar back`, sheet.profile.topics.length === 2 && sheet.profile.authors.length === 1 && sheet.profile.journals.length === 1 && sheet.feeds.length === 1 && Object.values(sheet.databases).every((v) => !v) && sheet.size.discover === 3, sheet);
      check(`${tag} Home now shows the Today block (the intro is gone)`, (await page.locator('.sbw-today-banner .sbw-cover-title').count()) === 1);

      // the Sources page reads it back: ring 5, the same chips on
      await go(page, '#/sources');
      await page.waitForSelector('.sbw-sources:not(.is-intro) .sbw-chip');
      const back = await page.evaluate(() => ({ ring: document.querySelector('.sbw-src-ring-n').textContent, on: [...document.querySelectorAll('.sbw-chip.is-on .sbw-chip-label')].map((x) => x.textContent).sort(), button: document.querySelector('.sbw-src-save').textContent }));
      check(`${tag} the Sources page shows the saved radar: ring 5, the same chips followed`, back.ring === '5' && JSON.stringify(back.on) === JSON.stringify(['A. Bramblewood', 'Good feed', 'Journal of Invented Zoology', 'burrow ecology', 'vole foraging behaviour']) && back.button === 'Save changes', back);
      check(`${tag} the page carries the explainer after the groups`, JSON.stringify(await page.locator('.sbw-src-col-title').allTextContents()) === '["What it includes","When","How to read it"]' && (await page.locator('.sbw-src-powered').textContent()) === 'Powered by your sources', await page.locator('.sbw-src-col-title').allTextContents());
      await page.close();
    }

    // a radar already set up: edit it on the Sources page
    {
      const { page, goto } = await open(fakeUrl, width);
      await goto();
      await page.waitForFunction(() => window.__sbWebReady === true, null, { timeout: 8000 });
      await go(page, '#/home');
      await page.waitForSelector('.sbw-today-banner');
      const home = await page.evaluate(() => ({ intro: Boolean(document.querySelector('.sbw-sources')), link: document.querySelector('.sbw-today-sources')?.getAttribute('href') ?? null, visible: document.querySelector('.sbw-today-sources')?.getBoundingClientRect().width > 0 }));
      check(`${tag} with a radar, Home keeps Today and offers a Sources link beside it`, !home.intro && home.link === '#/settings?section=radar' && home.visible, home);
      check(`${tag} Home with the Sources link has no sideways scroll`, await noSideways(page));
      await page.click('.sbw-today-sources');
      await page.waitForSelector('.sbw-sources .sbw-chip');
      const edit = await page.evaluate(() => ({ hash: location.hash, ring: document.querySelector('.sbw-src-ring-n').textContent, title: document.title, more: document.querySelector('.sbw-more').classList.contains('is-active') || getComputedStyle(document.querySelector('.sbw-more')).display === 'none', hasIntro: Boolean(document.querySelector('.is-intro')) }));
      check(`${tag} the Sources link opens Settings > Reading radar with the existing radar's 2 follows counted`, edit.hash === '#/settings?section=radar' && edit.ring === '2' && edit.title === 'Settings · Second Brain' && !edit.hasIntro && true, edit);
      check(`${tag} #/sources has no sideways page scroll`, await noSideways(page));
      check(`${tag} #/sources lights the More item in the rail`, edit.more, edit);
      const sizes = await page.evaluate(() => {
        const r = (sel) => document.querySelector(sel)?.getBoundingClientRect();
        const chips = [...document.querySelectorAll('.sbw-chip')].map((c) => c.getBoundingClientRect());
        const page = document.querySelector('.sbw-sources').getBoundingClientRect();
        return { overflow: chips.filter((c) => c.right > innerWidth + 0.5 || c.left < -0.5).length, minChipH: Math.min(...chips.map((c) => c.height)), diagram: r('.sbw-src-diagram')?.width, cols: getComputedStyle(document.querySelector('.sbw-src-cols')).gridTemplateColumns.split(' ').length, page: page.width, vw: innerWidth, gutter: (() => { const main = document.querySelector('.sbw-main').getBoundingClientRect(); return Math.min(r('.sbw-src-title').left - main.left, main.right - r('.sbw-src-hero').right); })() };
      });
      check(`${tag} the page keeps a 16 px side gutter, chips stay inside the screen, at least 36 px tall; the explainer has ${width < 700 ? 'one column' : 'three columns'}`, sizes.overflow === 0 && sizes.minChipH >= 36 && sizes.gutter >= 15.5 && sizes.cols === (width < 700 ? 1 : 3) && sizes.diagram <= sizes.page + 1, sizes);

      await chip(page, 'topics', 'seed hoarding').click();
      await chip(page, 'journals', 'Annals of Burrowing').click();
      await page.click('.sbw-src-follow');
      check(`${tag} the suggestion's Follow button follows it and the ring counts 5`, (await ringCount(page)) === '5', await ringCount(page));
      await page.fill('.sbw-src-group[data-group="journals"] .sbw-src-input', 'invented');
      await page.keyboard.press('Enter');
      await page.waitForSelector('.sbw-src-pick');
      const picks = await page.locator('.sbw-src-pick .sbw-src-pick-name').allTextContents();
      await page.locator('.sbw-src-pick', { hasText: 'Invented Reviews' }).click();
      check(`${tag} a journal name with several matches offers them, and picking one follows it`, JSON.stringify(picks) === '["Invented Letters","Invented Reviews"]' && (await ringCount(page)) === '6', picks);
      await page.fill('.sbw-src-group[data-group="feeds"] .sbw-src-input', 'https://nature.example/feed');
      await page.keyboard.press('Enter');
      await page.waitForSelector('.sbw-src-group[data-group="feeds"] .sbw-src-note .sbw-src-pick');
      check(`${tag} a feed the site blocks says so and offers the journal itself`, (await page.locator('.sbw-src-group[data-group="feeds"] .sbw-src-note').textContent()).includes('sign-in page') && (await page.locator('.sbw-src-group[data-group="feeds"] .sbw-src-pick-name').textContent()) === 'Nature of Voles');
      await page.fill('.sbw-src-group[data-group="journals"] .sbw-src-input', 'zzz');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('.sbw-src-group[data-group="journals"] .sbw-src-note')?.textContent.startsWith('No journal found'));
      check(`${tag} an unknown name gets a plain error`, (await page.locator('.sbw-src-group[data-group="journals"] .sbw-src-note').getAttribute('class')).includes('is-error'));
      await chip(page, 'databases', 'OpenAlex').click();
      if (width === 1280) await shot(page, 'edit');
      await page.click('.sbw-src-save');
      await page.waitForFunction(() => document.querySelector('.sbw-src-status')?.textContent.startsWith('Saved.'));
      const saves = await page.evaluate(() => window.__store.saves);
      const radar = saves?.[0]?.draft?.radar;
      check(`${tag} Save changes updates the existing radar with the new follows`,
        saves?.length === 1 && saves[0].kind === 'update' && saves[0].id === 'r2'
        && JSON.stringify(radar.profile.topics.map((t) => t.text)) === '["burrow ecology","seed hoarding"]'
        && radar.sources.some((s) => s.id === 'journal:S2' && s.on) && radar.sources.some((s) => s.id === 'journal:S6' && s.on)
        && radar.sources.some((s) => s.id === 'database:openalex' && s.on) && radar.sources.some((s) => s.id === 'database:arxiv' && s.on), saves);
      check(`${tag} saving says what happens next and links back to Home`, (await page.locator('.sbw-src-status').textContent()).startsWith('Saved. Your next issue:') && (await page.locator('.sbw-src-home').getAttribute('href')) === '#/home', await page.locator('.sbw-src-status').textContent());

      // problems are said in the person's words
      await page.reload();
      await page.waitForFunction(() => window.__sbWebReady === true, null, { timeout: 8000 });
      await go(page, '#/sources');
      await page.waitForSelector('.sbw-sources .sbw-chip');
      await chip(page, 'topics', 'burrow ecology').click();
      await page.click('.sbw-src-save');
      check(`${tag} saving with no topic says so`, (await page.locator('.sbw-src-status').textContent()) === 'Add at least one topic to look for.' && (await page.evaluate(() => window.__store.saves ?? [])).length === 0);

      // Settings reaches it: its own section, Reading radar
      await go(page, '#/settings');
      await page.locator('.sbs-nav-item', { hasText: 'Reading radar' }).first().click();
      await page.waitForSelector('.sbw-sources');
      check(`${tag} Settings > Reading radar shows the radar's setup`, (await page.locator('.sbw-sources.is-settings').count()) === 1);
      check(`${tag} the Sources page logged no errors`, page.errors.length === 0, page.errors);
      await page.close();
    }

    // "Not now" puts the first-run question off, and the setup banner then leads to Sources
    {
      const { page, goto } = await open(`${fakeUrl}&routines=none&issues=none`, width);
      await goto();
      await page.waitForFunction(() => window.__sbWebReady === true, null, { timeout: 8000 });
      await go(page, '#/home');
      await page.waitForSelector('.sbw-sources.is-intro');
      await page.click('.sbw-src-later');
      await page.waitForSelector('.sbw-today-banner');
      const later = await page.evaluate(() => ({ intro: Boolean(document.querySelector('.sbw-sources')), title: document.querySelector('.sbw-today-banner .sbw-cover-title').textContent, href: document.querySelector('.sbw-today-banner').getAttribute('href'), done: window.__host.prefs.get('sourcesIntroDone'), saves: window.__store.saves ?? [] }));
      check(`${tag} Not now remembers the choice, saves nothing, and the banner offers "Set up a reading radar" in Settings`, !later.intro && later.title === 'Set up a reading radar' && later.href === '#/settings?section=radar' && later.done === true && later.saves.length === 0, later);
      await page.close();
    }

    // both palettes
    for (const scheme of ['light', 'dark']) {
      const { page, goto } = await open(`${fakeUrl}&routines=none${scheme === 'dark' ? '&theme=dark' : ''}`, width, { colorScheme: scheme });
      await goto();
      await page.waitForFunction(() => window.__sbWebReady === true, null, { timeout: 8000 });
      await go(page, '#/sources');
      await page.waitForSelector('.sbw-sources .sbw-chip');
      await chip(page, 'topics', 'burrow ecology').click();
      await chip(page, 'databases', 'arXiv').click();
      const paint = await page.evaluate(() => {
        const color = (el, p) => getComputedStyle(el)[p];
        const on = document.querySelector('.sbw-chip.is-on');
        const off = document.querySelector('.sbw-chip:not(.is-on)');
        return { bg: color(document.body, 'backgroundColor'), text: color(document.body, 'color'), onBorder: color(on, 'borderTopColor'), offBorder: color(off, 'borderTopColor'), arc: color(document.querySelector('.sbw-src-ring-fill'), 'stroke'), track: color(document.querySelector('.sbw-src-ring-track'), 'stroke'), scroll: document.scrollingElement.scrollWidth <= innerWidth };
      });
      check(`${tag} ${scheme}: the on chip, the ring arc and the track are three different colours on the page background`, paint.onBorder !== paint.offBorder && paint.arc !== paint.track && paint.bg !== paint.arc && paint.bg !== paint.text && paint.scroll && (scheme === 'dark') === (paint.bg !== 'rgb(255, 255, 255)'), paint);
      await shot(page, scheme);
      await page.close();
    }
  }

  // ------------------------------------------------------------ rail geometry and both palettes (ledger 2, 11, 12)
  for (const [width, expectRail] of [[800, 56], [1280, 224]]) {
    const { page, goto } = await open(fakeUrl, width);
    await goto();
    await page.waitForFunction(() => window.__sbWebReady === true);
    const rail = await page.evaluate(() => {
      const item = document.querySelector('.sbw-nav-item[data-view="chat"]');
      const label = item.querySelector('.sbw-nav-label');
      const active = document.querySelector('.sbw-nav-item.is-active');
      return { w: document.querySelector('.sbw-rail').getBoundingClientRect().width, labelShown: getComputedStyle(label).display !== 'none', title: item.title, aria: item.getAttribute('aria-label'),
        radius: parseFloat(getComputedStyle(active).borderTopLeftRadius), fill: getComputedStyle(active).backgroundColor };
    });
    check(`${width}px the rail is ${expectRail} px wide${expectRail === 224 ? ' with labels' : ', icons only'}`, Math.round(rail.w) === expectRail && rail.labelShown === (expectRail === 224), rail);
    check(`${width}px rail items carry a tooltip and an aria-label; the selected one is a 6 px tinted fill`, rail.title === 'Chat' && rail.aria === 'Chat' && rail.radius === 6 && rail.fill !== 'rgba(0, 0, 0, 0)', rail);
    await page.close();
  }
  {
    const { page, goto } = await open(fakeUrl, 390, { viewport: { width: 390, height: 844 } });
    await goto();
    await page.waitForFunction(() => window.__sbWebReady === true);
    const bar = await page.evaluate(() => {
      const r = document.querySelector('.sbw-rail').getBoundingClientRect();
      return { h: r.height, bottom: r.bottom, vh: innerHeight, items: [...document.querySelectorAll('.sbw-nav-item')].filter((n) => getComputedStyle(n).display !== 'none').map((n) => n.getAttribute('aria-label')) };
    });
    check('390px the phone bar is 56 px along the bottom with Home, Chat, Library, Notes and More', bar.h === 56 && bar.bottom === bar.vh && JSON.stringify(bar.items) === '["Home","Chat","Library","Notes","More"]', bar);
    await page.close();
  }
  for (const [theme, scheme] of [['light', 'light'], ['dark', 'dark']]) {
    const { page, goto } = await open(`${fakeUrl}${theme === 'dark' ? '&theme=dark' : ''}`, 1280, { colorScheme: scheme });
    await goto();
    await page.waitForFunction(() => window.__sbWebReady === true);
    await page.waitForSelector('.sbw-cover');
    const paint = await page.evaluate(() => ({ bg: getComputedStyle(document.body).backgroundColor, text: getComputedStyle(document.body).color, scheme: getComputedStyle(document.documentElement).colorScheme }));
    check(`${theme} palette renders (page background and text differ, scheme is ${theme})`, paint.bg !== paint.text && paint.scheme === theme, paint);
    await page.screenshot({ path: join(outDir, `web-home-${theme}.png`) });
    await page.close();
  }

  // ------------------------------------------------------------ dialogs never block the page
  {
    const { page, goto } = await open(fakeUrl, 1280);
    await goto();
    await page.waitForFunction(() => window.__sbWebReady === true);
    const dialogs = await page.evaluate(async () => {
      const real = await import(new URLSearchParams(location.search).get('js'));
      const host = real.createWebHost({ base: location.origin, fetch: async () => new Response('{}') });
      window.alert = window.confirm = window.prompt = () => { throw new Error('native dialog'); };
      const ask = host.confirm('Delete it?');
      const open = document.querySelector('.sbw-dialog')?.textContent ?? '';
      document.querySelector('.sbw-dialog .is-primary').click();
      const yes = await ask;
      const named = host.promptText('Name', 'abc');
      document.querySelector('.sbw-dialog-input').value = 'xyz';
      document.querySelector('.sbw-dialog .is-primary').click();
      const text = await named;
      const again = host.confirm('Escape me');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      host.notice('Saved');
      return { open, yes, text, escaped: await again, left: document.querySelectorAll('.sbw-dialog').length, toast: document.querySelector('.sbw-toast')?.textContent };
    });
    check('confirm, promptText and notice are in-page dialogs', dialogs.open.includes('Delete it?') && dialogs.yes === true && dialogs.text === 'xyz' && dialogs.escaped === false && dialogs.left === 0 && dialogs.toast === 'Saved', dialogs);
    await page.close();
  }

  // ------------------------------------------------------------ the real web host against a scripted server
  const server = scriptedServer();
  for (const width of WIDTHS) {
    const { page, goto } = await open(`${origin}/dist-web/index.html#/home`, width);
    server.attach(page);
    await goto();
    await page.waitForSelector('.sbw-cover');
    const tag = `${width}px real host`;
    check(`${tag} Home reads conversations through /agent`, (await page.locator('.sbw-cover .sbw-cover-title').allTextContents()).includes('Foraging in voles'));
    check(`${tag} no sideways page scroll`, await noSideways(page));
    if (width === 1280) {
      // a turn: POST /agent/conversations/send, then the answer arrives over the long-poll /agent/events?after=
      await go(page, '#/chat');
      await page.waitForSelector('.sb-ai-input');
      await page.fill('.sb-ai-input', 'Hello server');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => [...document.querySelectorAll('.sb-ai-answer')].some((t) => t.textContent.includes('Server says: Hello server')), null, { timeout: 8000 });
      check(`${tag} a turn goes out over fetch and its answer comes back over the long-poll`, server.sent.length === 1 && server.eventPolls >= 1, { sent: server.sent, polls: server.eventPolls });
      check(`${tag} the poll resumes from the last event it saw`, server.afters.every((a, i) => i === 0 || a >= server.afters[i - 1]), server.afters);

      // prefs are written through to /web/state
      await page.evaluate(() => document.querySelector('.sb-ai-modepick') && (document.querySelector('.sb-ai-modepick').value = 'ask', document.querySelector('.sb-ai-modepick').dispatchEvent(new Event('change'))));
      await page.waitForTimeout(700);
      check(`${tag} prefs write through to /web/state`, server.state.prefs.chatMode === 'ask', server.state);

      // a fresh load sees them (state is read before the UI is built)
      await page.reload();
      await page.waitForSelector('.sb-ai-modepick');
      check(`${tag} the saved mode is back after a reload`, (await page.locator('.sb-ai-modepick').inputValue()) === 'ask');

      // theme choice
      await go(page, '#/settings');
      await page.locator('input[name="sbs-general.theme"][value="dark"]').check();
      await page.waitForTimeout(500);
      check(`${tag} the theme choice applies and is saved`, (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark' && server.state.prefs.webTheme === 'dark', server.state);

      // Open links (spec 015 seam, spec 016 U6): the web app opens links inside, so the row shows and writes prefs.openLinks
      await go(page, '#/settings');
      const openLinks = page.locator('[data-row="general.openLinks"]');
      await openLinks.waitFor();
      check(`${tag} Open links starts on Inside the app`, await openLinks.locator('input[value="inside"]').isChecked());
      await openLinks.locator('input[value="outside"]').check();
      await page.waitForTimeout(500);
      check(`${tag} choosing In your browser saves prefs.openLinks`, server.state.prefs.openLinks === 'outside', server.state.prefs);
      await openLinks.locator('input[value="inside"]').check();
      await page.waitForTimeout(500);

      // the OpenAlex key row (Finding papers): status line, save, never shows the key back, remove
      await go(page, '#/settings?section=papers');
      const keyRow = page.locator('.sb-openalex-key');
      await keyRow.waitFor();
      check(`${tag} the OpenAlex row starts on the shared limit with a free-key link`, (await keyRow.locator('.sb-openalex-status').textContent()) === 'Using the shared free limit' && (await keyRow.locator('a').getAttribute('href')) === 'https://openalex.org/settings/api' && (await keyRow.locator('input').getAttribute('type')) === 'password');
      await keyRow.locator('input').fill('abc-123');
      await keyRow.getByRole('button', { name: 'Save' }).click();
      await page.waitForFunction(() => document.querySelector('.sb-openalex-status')?.textContent === 'Key saved');
      check(`${tag} saving posts the key, clears the field and says Key saved`, server.openalex.apiKey === 'abc-123' && (await keyRow.locator('input').inputValue()) === '' && !(await page.content()).includes('abc-123'), server.openalex);
      server.openalex.limitUntil = new Date(Date.now() + 3600_000).toISOString();
      await page.reload();
      await page.waitForSelector('.sb-openalex-status');
      await page.waitForFunction(() => /^Limit reached until /.test(document.querySelector('.sb-openalex-status')?.textContent ?? ''));
      server.openalex.limitUntil = null;
      await page.locator('.sb-openalex-key').getByRole('button', { name: 'Remove' }).click();
      await page.waitForFunction(() => document.querySelector('.sb-openalex-status')?.textContent === 'Using the shared free limit');
      check(`${tag} the limit shows its reset time, and Remove returns to the shared limit`, server.openalex.apiKey === null);

      // the manifest is real
      const manifest = await page.evaluate(() => fetch('manifest.webmanifest').then((r) => r.text()).then(JSON.parse));
      check(`${tag} the manifest names the app and installs standalone`, manifest.name === 'Second Brain' && manifest.display === 'standalone' && manifest.icons.length > 0 && (await page.title()) === 'Settings · Second Brain', manifest);
      await page.screenshot({ path: join(outDir, 'web-real-1280.png') });
    }
    check(`${tag} logged no errors`, page.errors.filter((e) => !/Failed to load resource/.test(e)).length === 0, page.errors);
    await page.close();
  }

  // ------------------------------------------------------------ Settings > Models (spec 016 U3)
  {
    server.providers = [
      { provider: 'claude', state: 'ready', version: null, account: { kind: 'claude', label: 'ada@example.org', plan: 'Max plan' }, usage: null, installHelp: null },
      { provider: 'codex', state: 'missing', version: null, account: { kind: 'none', label: null, plan: null }, usage: null, installHelp: 'Install the ChatGPT app to use your ChatGPT plan.' },
      { provider: 'local', state: 'ready', version: null, account: { kind: 'none', label: null, plan: null }, usage: null, installHelp: null, detail: '2 models found.' },
    ];
    const { page, goto } = await open(`${origin}/dist-web/index.html#/settings?section=models`, 1280);
    server.attach(page);
    await goto();
    await page.waitForSelector('.sbm .sbm-models');
    const tag = '1280px models';
    const last = () => server.patches.at(-1);
    const heads = await page.locator('.sbm-head').allTextContents();
    check(`${tag} the groups are Default, Cloud and On this Mac`, heads.join('|') === 'Default|Cloud|On this Mac', heads);
    const claudeRow = page.locator('.sbm-row[data-provider="claude"]');
    const codexRow = page.locator('.sbm-row[data-provider="codex"]');
    check(`${tag} Claude Code is Ready with its account; Codex is Not installed with How to install`,
      (await claudeRow.locator('.sbm-pill').textContent()) === 'Ready' && (await claudeRow.textContent()).includes('ada@example.org')
      && (await codexRow.locator('.sbm-pill').textContent()) === 'Not installed' && (await codexRow.getByRole('button', { name: 'How to install' }).count()) === 1);
    await codexRow.getByRole('button', { name: 'How to install' }).click();
    check(`${tag} How to install shows the plain-language guide`, (await codexRow.textContent()).includes('Install the ChatGPT app'));
    check(`${tag} a model shows one grey hint`, (await page.locator('.sbm-model', { hasText: 'Sonnet' }).locator('.sbm-model-hint').textContent()) === 'good for most questions');
    check(`${tag} the footnote is there`, (await page.locator('.sbm-foot').textContent()) === 'Ticked models show in the Answer with menu under Cloud.');

    await page.locator('select[aria-label="Default model"]').selectOption('claude:sonnet');
    await page.waitForFunction(() => document.querySelector('select[aria-label="Default model: effort"]'));
    await page.locator('select[aria-label="Default model: effort"]').selectOption('high');
    await page.waitForFunction(() => document.querySelector('select[aria-label="Default model: effort"]').value === 'high');
    check(`${tag} the default model is saved with its effort`, JSON.stringify(server.engine.defaultModel) === JSON.stringify({ provider: 'claude', model: 'sonnet', effort: 'high' }), server.engine.defaultModel);

    check(`${tag} Per task starts collapsed on "All same as default"`, (await page.locator('.sbm-tasks').count()) === 0 && (await page.getByText('All same as default').count()) === 1);
    await page.getByRole('button', { name: 'Change ›' }).click();
    check(`${tag} Change opens the six tasks, each Same as default`, (await page.locator('.sbm-tasks select').count()) === 6 && (await page.locator('.sbm-tasks select').evaluateAll((els) => els.every((e) => e.value === ''))));
    await page.locator('select[aria-label="Writing a review"]').selectOption('claude:opus');
    await page.waitForFunction(() => document.querySelector('select[aria-label="Writing a review"]').value === 'claude:opus');
    check(`${tag} a task with its own model saves provider and model`, JSON.stringify(server.engine.roles.writer) === JSON.stringify({ provider: 'claude', model: 'opus' }), server.engine.roles);
    await page.locator('select[aria-label="Writing a review"]').selectOption('');
    await page.waitForFunction(() => document.querySelector('select[aria-label="Writing a review"]').value === '');
    check(`${tag} choosing Same as default again clears the task`, JSON.stringify(last().roles) === '{"writer":null}' && server.engine.roles.writer === undefined, last());
    await page.getByRole('button', { name: 'Done' }).click();

    await page.locator('input[data-model="claude:haiku"]').check();
    await page.waitForFunction(() => document.querySelector('input[data-model="claude:haiku"]').checked);
    check(`${tag} ticking a model writes shownModels as provider:id`, server.engine.shownModels.join() === 'claude:haiku', server.engine.shownModels);

    await page.getByRole('button', { name: '+ Add a model ID' }).click();
    await page.locator('input[aria-label="Model ID for Claude Code"]').fill('claude-sonnet-4-5-20250929');
    await page.keyboard.press('Enter');
    await page.waitForSelector('input[data-model="claude:claude-sonnet-4-5-20250929"]');
    check(`${tag} Add a model ID writes addedModels and the model appears ticked`, JSON.stringify(server.engine.addedModels) === JSON.stringify([{ provider: 'claude', id: 'claude-sonnet-4-5-20250929' }]) && (await page.locator('input[data-model="claude:claude-sonnet-4-5-20250929"]').isChecked()), server.engine);

    await page.getByRole('button', { name: '+ Add', exact: true }).click();
    await page.waitForSelector('.sbm-drawer');
    check(`${tag} the drawer has name, address, key and Fetch models`, (await page.locator('.sbm-drawer input').count()) === 3 && (await page.getByRole('button', { name: 'Fetch models' }).count()) === 1);
    await page.locator('.sbm-drawer input[aria-label="Name"]').fill('or');
    await page.locator('.sbm-drawer input[aria-label="Address"]').fill('openrouter.ai/api/v1');
    await page.locator('.sbm-drawer input[aria-label="Key"]').fill('sk-test-1');
    await page.getByRole('button', { name: 'Show', exact: true }).click();
    check(`${tag} Show reveals the key`, (await page.locator('.sbm-drawer input[aria-label="Key"]').getAttribute('type')) === 'text');
    await page.getByRole('button', { name: 'Fetch models' }).click();
    await page.waitForSelector('.sbm-found input');
    check(`${tag} Fetch models asks the endpoint through /providers/models?provider=oss:or and lists what it has`,
      server.modelsAsked.includes('oss:or') && (await page.locator('.sbm-found input').count()) === 2 && JSON.stringify(server.engine.endpoints) === JSON.stringify([{ name: 'or', baseUrl: 'http://openrouter.ai/api/v1', key: 'sk-test-1' }]), { asked: server.modelsAsked, endpoints: server.engine.endpoints });
    await page.locator('.sbm-found input').first().check();
    await page.screenshot({ path: join(outDir, 'models-drawer-1280.png') });
    await page.locator('.sbm-drawer').getByRole('button', { name: 'Save' }).click();
    await page.waitForSelector('.sbm-drawer', { state: 'detached' });
    check(`${tag} Save keeps the endpoint and shows its ticked model`, server.engine.shownModels.includes('oss:or:meta/llama-3.1-70b') && (await page.locator('.sbm-row[data-provider="oss:or"]').count()) === 1, server.engine);
    await page.getByRole('button', { name: '+ Add', exact: true }).click();
    await page.locator('.sbm-drawer input[aria-label="Name"]').fill('lab');
    await page.locator('.sbm-drawer input[aria-label="Address"]').fill('http://10.0.0.2:8000/v1');
    await page.getByRole('button', { name: 'Fetch models' }).click();
    await page.waitForFunction(() => document.querySelector('.sbm-note, .sbm-drawer-note')?.textContent || document.querySelector('.sbm-found input'));
    await page.locator('.sbm-drawer').getByRole('button', { name: 'Cancel' }).click();
    await page.waitForSelector('.sbm-drawer', { state: 'detached' });
    check(`${tag} Cancel after Fetch models takes the unsaved service back out`, server.engine.endpoints.map((e) => e.name).join() === 'or', server.engine.endpoints);
    check(`${tag} no sideways page scroll`, await noSideways(page));
    await page.evaluate(() => { document.querySelector('.sbs-pane').scrollTop = 0; });
    await page.screenshot({ path: join(outDir, 'models-1280.png') });

    await page.getByRole('button', { name: 'Open ›' }).click();
    check(`${tag} the On this Mac row opens that section`, (await page.locator('.sbs-nav-item.is-active').textContent()) === 'On this Mac');
    check(`${tag} the section list fills the height of the window`, await page.evaluate(() => { const side = document.querySelector('.sbs-side').getBoundingClientRect(); return Math.abs(side.bottom - window.innerHeight) <= 1; }));
    check(`${tag} logged no errors`, page.errors.filter((e) => !/Failed to load resource/.test(e)).length === 0, page.errors);
    await page.close();
  }
  {
    const { page, goto } = await open(`${origin}/dist-web/index.html#/settings?section=models`, 390);
    server.attach(page);
    await goto();
    await page.waitForSelector('.sbm .sbm-models');
    const tag = '390px models';
    check(`${tag} no sideways page scroll`, await noSideways(page));
    check(`${tag} nothing in the section is wider than the screen`, await page.evaluate(() => [...document.querySelectorAll('.sbm *')].every((el) => el.getBoundingClientRect().right <= window.innerWidth + 1)));
    await page.getByRole('button', { name: 'Change ›' }).click();
    await page.screenshot({ path: join(outDir, 'models-390.png'), fullPage: true });
    await page.getByRole('button', { name: 'Done' }).click();
    await page.getByRole('button', { name: '+ Add', exact: true }).click();
    await page.waitForSelector('.sbm-drawer');
    check(`${tag} the drawer fits the screen`, await page.evaluate(() => { const r = document.querySelector('.sbm-drawer').getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1; }));
    await page.screenshot({ path: join(outDir, 'models-drawer-390.png') });
    check(`${tag} logged no errors`, page.errors.filter((e) => !/Failed to load resource/.test(e)).length === 0, page.errors);
    await page.close();
  }

  // the server going away shows as offline, and the app recovers
  {
    const { page, goto } = await open(`${origin}/dist-web/index.html#/chat`, 1280);
    server.attach(page);
    await goto();
    await page.waitForSelector('.sb-ai-where');
    server.down = true;
    await page.evaluate(() => fetch('/ping').catch(() => {}));
    await page.waitForFunction(() => /computer|offline/i.test(document.querySelector('.sb-ai-where')?.textContent ?? ''), null, { timeout: 4000 }).catch(() => {});
    check('an unreachable server does not break the page', (await page.evaluate(() => document.querySelectorAll('.sb-ai').length)) === 1);
    server.down = false;
    await page.close();
  }

  return { failures, count };
}

/** A scripted stand-in for the KB server's routes the app uses; `attach(page)` answers them through page.route. */
function scriptedServer() {
  const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString();
  const s = {
    down: false,
    state: { prefs: {}, files: {} },
    openalex: { apiKey: /** @type {string | null} */ (null), limitUntil: /** @type {string | null} */ (null) },
    // the Models section: what the engine holds, and the provider states and model lists it reports
    engine: { roles: {}, endpoints: [], shownModels: [], addedModels: [], defaultModel: null },
    providers: /** @type {any[] | null} */ (null),
    modelsAsked: /** @type {string[]} */ ([]),
    sent: [], afters: [], eventPolls: 0, patches: /** @type {any[]} */ ([]),
    convs: [
      { id: 'c1', mode: 'chat', title: 'Foraging in voles', updated: hoursAgo(2), artifacts: 0, kind: 'chat' },
      { id: 'c2', mode: 'chat', title: 'Doorknob ergonomics', updated: hoursAgo(30), artifacts: 0, kind: 'chat' },
    ],
    log: /** @type {{ seq: number, type: string, [k: string]: any }[]} */ ([]),
    attach(page) {
      page.route(/\/(web|agent|ping|status|zotero|search|recent|links)\b/, async (route) => {
        const url = new URL(route.request().url());
        const method = route.request().method();
        const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
        if (s.down) return route.abort();
        const path = url.pathname;
        if (path === '/ping') return json({ ok: true });
        if (path === '/web/state') {
          if (method === 'POST') {
            const body = JSON.parse(route.request().postData() ?? '{}');
            Object.assign(s.state.prefs, body.prefs ?? {});
            Object.assign(s.state.files, body.files ?? {});
          }
          return json(s.state);
        }
        if (path === '/status') return json({ coverage: [{ source: 'zotero', documents: 12 }], running: false });
        if (path === '/zotero/collections' || path === '/recent') return json([]);
        if (!path.startsWith('/agent/')) return route.fallback();
        const api = path.slice('/agent'.length);
        if (api === '/conversations' && method === 'GET') return json(s.convs);
        if (api === '/conversations' && method === 'POST') { s.convs.unshift({ id: 'c9', mode: 'chat', title: 'New chat', updated: hoursAgo(0), artifacts: 0, kind: 'chat' }); return json({ id: 'c9' }); }
        if (api === '/conversations/cursor') return json({ seq: s.log.length, inFlight: false });
        if (api === '/conversations/load') return json([]);
        if (api === '/conversations/seen' || api === '/conversations/rename') return json({ ok: true });
        if (api === '/reviews/estimate') return json({ turns: 12, low: 9, high: 17, range: '9-17' });
        if (api === '/conversations/send') {
          const body = JSON.parse(route.request().postData() ?? '{}');
          s.sent.push(body.text);
          setTimeout(() => s.log.push({ seq: s.log.length + 1, type: 'done', answer: { text: `Server says: ${body.text}`, citations: [], structured: null, usage: {} } }), 150);
          return json([]);
        }
        if (api === '/events') {
          s.eventPolls += 1;
          const after = Number(url.searchParams.get('after') ?? 0);
          s.afters.push(after);
          for (let i = 0; i < 20 && s.log.length <= after; i++) await new Promise((r) => setTimeout(r, 50));
          return json(s.log.filter((e) => e.seq > after));
        }
        if (api === '/providers') return json(s.providers ?? [{ provider: 'codex', state: 'ready', version: null, account: { kind: 'chatgpt', label: null, plan: null }, usage: null, installHelp: null }]);
        if (api === '/providers/roles') return json({});
        if (api === '/providers/models') {
          const provider = url.searchParams.get('provider') ?? '';
          s.modelsAsked.push(provider);
          const added = s.engine.addedModels.filter((a) => a.provider === provider).map((a) => ({ id: a.id, label: a.id, hint: null, efforts: [], source: 'added', isDefault: false }));
          if (provider === 'claude') return json([
            { id: 'fable', label: 'Fable', hint: 'strongest, slowest', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], source: 'builtin', isDefault: false },
            { id: 'opus', label: 'Opus', hint: 'deep reports', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], source: 'builtin', isDefault: false },
            { id: 'sonnet', label: 'Sonnet', hint: 'good for most questions', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], source: 'builtin', isDefault: false },
            { id: 'haiku', label: 'Haiku', hint: 'fastest, cheapest', efforts: [], source: 'builtin', isDefault: false },
            ...added]);
          if (provider === 'oss:or') return json([
            { id: 'meta/llama-3.1-70b', label: 'meta/llama-3.1-70b', hint: null, efforts: [], source: 'provider', isDefault: false },
            { id: 'mistral/large', label: 'mistral/large', hint: null, efforts: [], source: 'provider', isDefault: false }]);
          return json([]);
        }
        if (api === '/routines' || api === '/projects' || api === '/skills' || api === '/reviews') return json([]);
        if (api === '/settings') {
          if (method === 'POST') {
            const patch = JSON.parse(route.request().postData() ?? '{}');
            if (patch.openalex && patch.openalex.apiKey !== undefined) s.openalex.apiKey = patch.openalex.apiKey || null;
            s.patches.push(patch);
            for (const [role, v] of Object.entries(patch.roles ?? {})) { if (v === null) delete s.engine.roles[role]; else s.engine.roles[role] = v; }
            for (const k of ['endpoints', 'shownModels', 'addedModels', 'defaultModel']) if (patch[k] !== undefined) s.engine[k] = patch[k];
          }
          return json({ ...s.engine, openalex: s.openalex });
        }
        return json({ error: `unscripted ${api}` }, 404);
      });
    },
  };
  return s;
}
