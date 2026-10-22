#!/usr/bin/env node
// ui-src/dev/run.mjs. Playwright over the shared harness (dev/harness/index.html): both token maps, light and
// dark, screenshotting the trivial stage-B component to dev/out/ (git-ignored). Run by `npm test` after the
// node --test unit tests. Requires the harness's own build to be current (`npm run build` first).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { runArtifactChecks } from './artifacts-checks.mjs';
import { runColumnChecks } from './columns-checks.mjs';
import { runPapersChatChecks } from './papers-chat-checks.mjs';
import { runStepsChecks } from './steps-checks.mjs';
import { runLiveChecks } from './live-checks.mjs';
import { runReportChecks } from './report-checks.mjs';
import { runPanelsChecks } from './panels-checks.mjs';
import { runLocalChecks } from './local-checks.mjs';
import { runWebChecks } from './web-checks.mjs';
import { runWebLibraryChecks } from './web-library-checks.mjs';
import { runWebPhoneChecks } from './web-phone-checks.mjs';
import { runRadarChecks } from './radar-checks.mjs';
import { runDigestChecks } from './digest-checks.mjs';
import { runHomeChecks } from './home-checks.mjs';
import { runBrowserChecks } from './browser-checks.mjs';

// SB_ONLY=local,panels runs just those suites (artifacts, columns, papers, steps, live, report, panels, local, web, weblib, webphone, radar, digest, home, browser) after the quick page checks.
const only = process.env.SB_ONLY ? new Set(process.env.SB_ONLY.split(',')) : null;
const want = (name) => !only || only.has(name);
const skipped = { failures: 0, count: 0 };
const root = fileURLToPath(new URL('..', import.meta.url)); // ui/
const repoRoot = fileURLToPath(new URL('../../zotero', import.meta.url)); // zotero/
const webRoot = fileURLToPath(new URL('../../web', import.meta.url)); // web/
// The web app lives in ../web: its bundle is served as /dist-web/… and its sources as /src/web/… (their old place).
const webFile = (/** @type {string} */ path) => path.startsWith('/dist-web/') ? join(webRoot, path)
  : path.startsWith('/src/web/') ? join(webRoot, 'src', path.slice('/src/web/'.length)) : null;
const outDir = fileURLToPath(new URL('out', import.meta.url));
await import('node:fs/promises').then((fs) => fs.mkdir(outDir, { recursive: true }));

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.webp': 'image/webp' };

const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (path === '/favicon.ico') { res.writeHead(204); res.end(); return; } // a full Chrome asks for one; the headless shell does not
    // Serve both ui-src/ (as /ui-src/…) and the zotero-plugin repo root (as /repo/…), so the harness's relative
    // link to ../../../content/sb-ui.css resolves the same way it will from content/ in the real Zotero build.
    const file = path.startsWith('/repo/') ? join(repoRoot, path.slice('/repo/'.length)) : webFile(path) ?? join(root, path);
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();

// SB_BROWSER=/path/to/Chrome (or Chromium) runs the harness on an installed browser when Playwright's own download is not present.
const browser = await chromium.launch(process.env.SB_BROWSER ? { executablePath: process.env.SB_BROWSER } : {});
let failures = 0;
const parityTrees = {}; // spec 005 C4: filled in below, compared once both are in hand
for (const tokens of ['zotero', 'obsidian']) {
  for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ colorScheme: theme });
    const errors = [];
    page.on('pageerror', (err) => errors.push(String(err)));
    page.on('console', (msg) => { if (msg.type() === 'error') errors.push(`${msg.text()}${msg.location()?.url ? ` (${msg.location().url})` : ''}`); });
    await page.goto(`http://127.0.0.1:${port}/dev/harness/index.html?tokens=${tokens}&theme=${theme}`);
    await page.waitForFunction(() => window.__sbHarnessReady === true, { timeout: 5000 });
    const demo = page.locator('#demo');
    const pillCount = await demo.locator('.sb-p-pill').count();
    const iconCount = await demo.locator('.sb-p-icon-row .sb-p-icon').count();
    const name = `demo-${tokens}-${theme}`;
    await page.screenshot({ path: join(outDir, `${name}.png`) });
    const ok = errors.length === 0 && pillCount === 4 && iconCount > 0;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${pillCount} pills, ${iconCount} icons${errors.length ? `, errors: ${errors.join(' | ')}` : ''}`);
    if (!ok) failures += 1;

    // spec 005 C1: every chat mode's empty state, real ChatView instances (not the trivial demo).
    const modeClasses = ['chat-mode-chat', 'chat-mode-ask', 'chat-mode-find', 'chat-mode-report'];
    let modesOk = true;
    for (const cls of modeClasses) {
      const empty = page.locator(`.${cls} .sb-ai-empty-title`);
      const count = await empty.count();
      if (count !== 1) modesOk = false;
    }
    await page.locator('#chats').screenshot({ path: join(outDir, `chats-${tokens}-${theme}.png`) }).catch(() => {});
    const chatsOk = modesOk && errors.length === 0;
    console.log(`${chatsOk ? 'PASS' : 'FAIL'} chats-${tokens}-${theme}: 4 modes rendered=${modesOk}, errors=${errors.length}`);
    if (!chatsOk) failures += 1;

    // Tokens must resolve in the chat itself: the Obsidian map once read theme variables at :root, where Obsidian
    // doesn't define them, so every --sb-ui-* came out empty and the chat rendered unstyled.
    const tokenProbe = await page.evaluate(() => {
      const chat = document.querySelector('#chats .sb-ai');
      const box = document.querySelector('#chats .sb-ai-box');
      if (!chat || !box) return { ok: false, detail: 'no chat/box' };
      const names = ['--sb-ui-bg', '--sb-ui-text', '--sb-ui-line', '--sb-ui-accent'];
      const empty = names.filter((n) => !getComputedStyle(chat).getPropertyValue(n).trim());
      const border = getComputedStyle(box).borderTopWidth;
      return { ok: empty.length === 0 && border !== '0px', detail: { empty, border } };
    });
    console.log(`${tokenProbe.ok ? 'PASS' : 'FAIL'} tokens-${tokens}-${theme}: --sb-ui-* resolve in the chat${tokenProbe.ok ? '' : ` :: ${JSON.stringify(tokenProbe.detail)}`}`);
    if (!tokenProbe.ok) failures += 1;

    // spec 007 E2: activity lines + folded reasoning -- one collapsed line, one expanded (chevron + reasoning +
    // labels visible), both maps, both themes.
    const activityDemo = page.locator('#activity-demo');
    const collapsedCount = await activityDemo.locator('.sb-ai-activity:not(.is-expanded)').count();
    const expandedCount = await activityDemo.locator('.sb-ai-activity.is-expanded .sb-ai-activity-reasoning').count();
    await activityDemo.screenshot({ path: join(outDir, `activity-${tokens}-${theme}.png`) }).catch(() => {});
    const activityOk = collapsedCount === 1 && expandedCount === 1 && errors.length === 0;
    console.log(`${activityOk ? 'PASS' : 'FAIL'} activity-${tokens}-${theme}: collapsed=${collapsedCount}, expanded-with-reasoning=${expandedCount}`);
    if (!activityOk) failures += 1;

    // spec 005 C2: the four source pills (defaults, migration, disabling, the offline mark, what a sent
    // request carries). Runs once (tokens=zotero, theme=light) — it's behaviour, not pixels.
    if (tokens === 'zotero' && theme === 'light') {
      const sourceChecks = await page.evaluate(() => window.__sbSourceChecks);
      for (const { name, ok, detail } of sourceChecks) {
        console.log(`${ok ? 'PASS' : 'FAIL'} sources: ${name}${ok ? '' : ` :: ${JSON.stringify(detail)}`}`);
        if (!ok) failures += 1;
      }
      if (!sourceChecks.length) { console.log('FAIL sources: no checks ran'); failures += 1; }
    }

    // spec 005 C4 (drift guard): captured once per token map (light theme only -- it's DOM structure, not pixels).
    if (theme === 'light') {
      const tree = await page.evaluate(() => window.__sbParityTree);
      if (!tree || !Object.keys(tree).length) { console.log(`FAIL parity: no tree captured for ${tokens}`); failures += 1; }
      else parityTrees[tokens] = tree;
    }
    await page.close();
  }
}
if (parityTrees.zotero && parityTrees.obsidian) {
  const states = new Set([...Object.keys(parityTrees.zotero), ...Object.keys(parityTrees.obsidian)]);
  for (const state of states) {
    const a = JSON.stringify(parityTrees.zotero[state]);
    const b = JSON.stringify(parityTrees.obsidian[state]);
    const ok = a !== undefined && a === b;
    console.log(`${ok ? 'PASS' : 'FAIL'} parity: ${state} DOM class tree is identical (Zotero token map vs. Obsidian token map)`);
    if (!ok) failures += 1;
  }
} else {
  console.log('FAIL parity: missing a token map\'s tree entirely');
  failures += 1;
}
// spec 008: behaviour checks (dev/harness/behavior.js). Every check runs with motion allowed; the motion probe
// runs again under prefers-reduced-motion, where the shimmer and the dot chase must be off.
let behaviorCount = 0;
for (const reducedMotion of ['no-preference', 'reduce']) {
  const page = await browser.newPage({ reducedMotion, viewport: { width: 900, height: 900 } });
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  await page.goto(`http://127.0.0.1:${port}/dev/harness/behavior.html`);
  await page.waitForFunction(() => window.__sbBehavior, null, { timeout: 5000 });
  const names = reducedMotion === 'reduce' ? ['motion-probe'] : await page.evaluate(() => window.__sbBehavior.names);
  for (const name of names) {
    const result = await page.evaluate((n) => window.__sbBehavior.run(n), name);
    let ok = result.ok && errors.length === 0;
    if (name === 'motion-probe') {
      const m = result.detail;
      ok = errors.length === 0 && (reducedMotion === 'reduce'
        ? m.workedAnim === 'none' && m.activityAnim === 'none' && !m.dotShown && m.stillShown && m.workedColor !== 'rgba(0, 0, 0, 0)'
        : m.workedAnim !== 'none' && m.activityAnim !== 'none' && m.dotAnim !== 'none' && m.dotShown && !m.stillShown);
    }
    const label = name === 'motion-probe' ? `motion (${reducedMotion})` : name;
    console.log(`${ok ? 'PASS' : 'FAIL'} behaviour: ${label}${ok ? '' : ` :: ${JSON.stringify(result.detail)}${errors.length ? ` errors: ${errors.join(' | ')}` : ''}`}`);
    if (!ok) failures += 1;
    behaviorCount += 1;
  }
  await page.screenshot({ path: join(outDir, `behavior-${reducedMotion}.png`), fullPage: true });
  await page.close();
}

// spec 007 E3: result cards, the artifact panel, versions, search and sort, export, the three widths (dev/artifacts-checks.mjs)
const artifacts = want('artifacts') ? await runArtifactChecks(browser, port, outDir) : skipped;
failures += artifacts.failures;

// spec 007 E4: columns (live fill, Stop / Fill the rest), filters, Keep these N, the narrow sheets (dev/columns-checks.mjs)
const columns = want('columns') ? await runColumnChecks(browser, port, outDir) : skipped;
failures += columns.failures;

// spec 007 E5: Chat with papers (dev/papers-chat-checks.mjs)
const papersChat = want('papers') ? await runPapersChatChecks(browser, port, outDir) : skipped;
failures += papersChat.failures;

// spec 007 E6: grouped mode menu, Add step, the current-result chip, empty-state cards, the picker, saved searches imported once (dev/steps-checks.mjs)
const steps = want('steps') ? await runStepsChecks(browser, port, outDir) : skipped;
failures += steps.failures;

// the live activity feed and the composer layout (dev/live-checks.mjs)
const liveChecks = want('live') ? await runLiveChecks(browser, port, outDir) : skipped;
failures += liveChecks.failures;

// spec 007 E7: the clarify card, the plan card's criteria and columns, stage lines, evidence claims -> quotes (dev/report-checks.mjs)
const reportChecks = want('report') ? await runReportChecks(browser, port, outDir) : skipped;
failures += reportChecks.failures;

// spec 005 D1: the panel components (dev/panels-checks.mjs)
const panelsChecks = want('panels') ? await runPanelsChecks(browser, port, outDir) : skipped;
failures += panelsChecks.failures;

// spec 010 L5: the Answer-with menu and the passages block (dev/local-checks.mjs)
const localChecks = want('local') ? await runLocalChecks(browser, port, outDir) : skipped;
failures += localChecks.failures;

// spec 013 W1: the browser app (dev/web-checks.mjs), against the built dist-web/
const webChecks = want('web') ? await runWebChecks(browser, port, outDir) : skipped;
failures += webChecks.failures;

// spec 013 W2: Library, Notes, the readers and the shared Related / Links / Duplicates panels (dev/web-library-checks.mjs)
const webLibraryChecks = want('weblib') ? await runWebLibraryChecks(browser, port, outDir) : skipped;
failures += webLibraryChecks.failures;

// spec 013 W4: sign-in page, Settings QR, 360 px layout (dev/web-phone-checks.mjs)
const webPhoneChecks = want('webphone') ? await runWebPhoneChecks(browser, port, outDir) : skipped;
failures += webPhoneChecks.failures;

// spec 015 B3: the in-app browser panel (dev/browser-checks.mjs), against the built dist-web/
const browserChecks = want('browser') ? await runBrowserChecks(browser, port, outDir) : skipped;
failures += browserChecks.failures;

// spec 012 R2: the Reading radar setup sheet (dev/radar-checks.mjs)
const radarChecks = want('radar') ? await runRadarChecks(browser, port, outDir) : skipped;
failures += radarChecks.failures;

// spec 012 R4: the Reading radar's digest (dev/digest-checks.mjs)
const digestChecks = want('digest') ? await runDigestChecks(browser, port, outDir) : skipped;
failures += digestChecks.failures;

// spec 014 G4: the plugins' Home on a fake plugin host (dev/home-checks.mjs); it runs with the web suite, whose Home it shares.
const homeChecks = want('home') || want('web') ? await runHomeChecks(browser, port, outDir) : skipped;
failures += homeChecks.failures;

await browser.close();
server.close();

if (failures) {
  console.error(`${failures} harness screenshot check(s) failed`);
  process.exit(1);
}
console.log(`harness checks pass: 12 screenshot checks + 10 source-pill checks + 8 scope-picker checks (spec 008 Z4) + 7 DOM-parity checks + ${behaviorCount} behaviour checks + ${artifacts.count} artifact checks (spec 007 E3) + ${columns.count} columns and filters checks (spec 007 E4) + ${papersChat.count} chat-with-papers checks (spec 007 E5) + ${steps.count} steps checks (spec 007 E6) + ${liveChecks.count} live-feed and composer checks + ${reportChecks.count} report checks (spec 007 E7) + ${panelsChecks.count} panel checks (spec 005 D1) + ${localChecks.count} local-model checks (spec 010) + ${webChecks.count} web app checks (spec 013) + ${webLibraryChecks.count} library, notes, reader and shared-panel checks (spec 013 W2) + ${webPhoneChecks.count} phone checks (spec 013 W4) + ${radarChecks.count} reading radar checks (spec 012) + ${digestChecks.count} radar digest checks (spec 012 R4) + ${homeChecks.count} plugin Home checks (spec 014 G4) + ${browserChecks.count} in-app browser checks (spec 015) (dev/out/*.png)`);
