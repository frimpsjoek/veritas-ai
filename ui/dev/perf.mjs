#!/usr/bin/env node
// ui-src/dev/perf.mjs. Playwright-Chromium perf harness for the Second Brain chat UI (spec 009, step 1 of "Order
// of work": Chat UI + Obsidian CSS rows only -- not the server, not Zotero, not scheduling). Drives
// dev/harness/perf.html (plain) and dev/harness/perf-obsidian.html (real Obsidian CSS, Scenario A only) through
// window.__perfHarness (dev/harness/perf-common.js), which exercises the real ChatView code path
// (view.submit() -> a scripted fake-host reply() -> view.stream()) rather than a hand-rolled simulation.
//
// Usage: node dev/perf.mjs --out <path.json> [--repeats 5] [--inject-slowdown] [--quick]
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, cp, mkdtemp, rm, readFile as readFileP } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import os from 'node:os';
import { chromium } from 'playwright';

const execFileP = promisify(execFile);
/** Every HTTP >= 400 any page saw, deduplicated; a non-empty set fails the run (a 404 means the harness is measuring a broken page). */
const failedRequests = new Set();

// ------------------------------------------------------------------------------------------------------- CLI

const args = process.argv.slice(2);
function flag(name) { return args.includes(name); }
function opt(name, dflt) { const i = args.indexOf(name); return i === -1 ? dflt : args[i + 1]; }

const OUT = opt('--out', null);
if (!OUT) { console.error('usage: node dev/perf.mjs --out <path.json> [--repeats 5] [--inject-slowdown] [--quick]'); process.exit(1); }
const QUICK = flag('--quick');
const REPEATS = QUICK ? 1 : Number(opt('--repeats', '5'));
const INJECT_SLOWDOWN = flag('--inject-slowdown');

const root = fileURLToPath(new URL('..', import.meta.url)); // ui/
const repoRoot = fileURLToPath(new URL('../../zotero', import.meta.url)); // zotero/
const webRoot = fileURLToPath(new URL('../../web', import.meta.url)); // web/
// The web app lives in ../web: its bundle is served as /dist-web/… and its sources as /src/web/… (their old place).
const webFile = (/** @type {string} */ path) => path.startsWith('/dist-web/') ? join(webRoot, path)
  : path.startsWith('/src/web/') ? join(webRoot, 'src', path.slice('/src/web/'.length)) : null;
const cacheDir = fileURLToPath(new URL('.perf-cache', import.meta.url)); // ui-src/dev/.perf-cache/

// ------------------------------------------------------------------------------------------------------- stats

const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const stats = (a) => ({ median: round2(median(a)), min: round2(Math.min(...a)), max: round2(Math.max(...a)) });
const round2 = (n) => Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
const percentile = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };

// ------------------------------------------------------------------------------------------------------- whole-main-thread cost (CDP Performance.getMetrics, bracketed around one scenario run)

/** The four counters the weekly budget will actually use: total main-thread script/task/style-recalc/layout cost
 *  for one scenario run, read straight from CDP (not approximated from in-page instrumentation, which only sees
 *  ChatView.prototype.paintText's own wall-clock time -- renderTotalMs/renderP95Ms below -- not GC, compositing,
 *  or anything Chrome itself schedules on the main thread outside that one function). Values are cumulative
 *  since the page loaded, in seconds; multiplied by 1000 here, diffed by the caller. */
async function readMainThreadMetrics(cdp) {
  const { metrics } = await cdp.send('Performance.getMetrics');
  const map = Object.fromEntries(metrics.map((m) => [m.name, m.value]));
  return {
    scriptMs: (map.ScriptDuration ?? 0) * 1000,
    taskMs: (map.TaskDuration ?? 0) * 1000,
    recalcMs: (map.RecalcStyleDuration ?? 0) * 1000,
    layoutMs: (map.LayoutDuration ?? 0) * 1000,
  };
}
function diffMainThreadMetrics(before, after) {
  return {
    scriptMs: round2(after.scriptMs - before.scriptMs),
    taskMs: round2(after.taskMs - before.taskMs),
    recalcMs: round2(after.recalcMs - before.recalcMs),
    layoutMs: round2(after.layoutMs - before.layoutMs),
  };
}

// Chrome trace event categories for the saved Scenario A trace: devtools.timeline (the classic timeline events --
// FunctionCall, Layout, UpdateLayoutTree, Paint) plus its disabled-by-default sibling (finer-grained, the one
// Chrome DevTools itself records), blink.user_timing (User Timing marks) and v8.execute (JS execution). Matches
// what `browser.startTracing`/`stopTracing` (Chromium-only, CDP Tracing domain under the hood) actually honours --
// unlike `page.context().tracing.start({categories})`, which silently ignores `categories` and always records
// Playwright's own action-trace format instead of a raw Chrome performance trace.
const TRACE_CATEGORIES = ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink.user_timing', 'v8.execute'];

// ------------------------------------------------------------------------------------------------------- Obsidian CSS extraction

/** Extracts fresh Obsidian app.css + the vault's current theme + enabled snippets + the plugin's own styles.css
 *  into dev/.perf-cache/, and writes a manifest.json listing what it actually found (perf-obsidian.html loads
 *  from that manifest, so a missing file degrades gracefully instead of crashing the harness). Re-run before
 *  every perf.mjs run per spec, so an Obsidian update is picked up automatically. */
async function extractObsidianCss() {
  await mkdir(cacheDir, { recursive: true });
  const manifestFiles = [];

  const obsidianDir = join(os.homedir(), 'Library/Application Support/obsidian');
  let asarPath = null;
  try {
    const { readdir } = await import('node:fs/promises');
    const entries = (await readdir(obsidianDir)).filter((f) => /^obsidian-.*\.asar$/.test(f));
    if (entries.length) {
      entries.sort((a, b) => {
        const va = a.match(/[\d.]+/)?.[0] ?? '0';
        const vb = b.match(/[\d.]+/)?.[0] ?? '0';
        return va.localeCompare(vb, undefined, { numeric: true });
      });
      asarPath = join(obsidianDir, entries[entries.length - 1]); // newest by version
    }
  } catch { /* obsidianDir doesn't exist: fall through to the fallback path */ }
  if (!asarPath) {
    const fallback = '/Applications/Obsidian.app/Contents/Resources/obsidian.asar';
    if (existsSync(fallback)) asarPath = fallback;
  }

  if (asarPath) {
    try {
      await execFileP('npx', ['-y', '@electron/asar', 'extract-file', asarPath, 'app.css'], { cwd: cacheDir });
      manifestFiles.push('app.css');
      console.log(`obsidian css: extracted app.css from ${asarPath}`);
      // app.css references public/fonts/* and public/images/* relative to itself, so they must sit next to it.
      const unpacked = await mkdtemp(join(os.tmpdir(), 'sb-obsidian-asar-'));
      try {
        await execFileP('npx', ['-y', '@electron/asar', 'extract', asarPath, unpacked]);
        await rm(join(cacheDir, 'public'), { recursive: true, force: true });
        await cp(join(unpacked, 'public'), join(cacheDir, 'public'), { recursive: true });
        console.log('obsidian css: extracted public/ (fonts, images) next to app.css');
      } catch (err) {
        console.warn(`obsidian css: couldn't extract public/ from ${asarPath}: ${err.message}`);
      } finally {
        await rm(unpacked, { recursive: true, force: true });
      }
    } catch (err) {
      console.warn(`obsidian css: couldn't extract app.css from ${asarPath}: ${err.message}`);
    }
  } else {
    console.warn('obsidian css: no obsidian-*.asar found and no /Applications/Obsidian.app fallback; skipping app.css');
  }

  const vaultObsidianDir = join(os.homedir(), 'Documents/Second-Brain/.obsidian');
  let appearance = {};
  try {
    appearance = JSON.parse(await readFileP(join(vaultObsidianDir, 'appearance.json'), 'utf8'));
  } catch (err) {
    console.warn(`obsidian css: couldn't read appearance.json: ${err.message}`);
  }

  if (appearance.cssTheme) {
    const themePath = join(vaultObsidianDir, 'themes', appearance.cssTheme, 'theme.css');
    if (existsSync(themePath)) {
      await writeFile(join(cacheDir, 'theme.css'), await readFileP(themePath));
      manifestFiles.push('theme.css');
    } else {
      console.warn(`obsidian css: theme "${appearance.cssTheme}" has no theme.css at ${themePath}, skipping`);
    }
  }

  for (const name of appearance.enabledCssSnippets ?? []) {
    const snippetPath = join(vaultObsidianDir, 'snippets', `${name}.css`);
    if (existsSync(snippetPath)) {
      const safe = name.replace(/[^a-z0-9-]+/gi, '_');
      await writeFile(join(cacheDir, `snippet-${safe}.css`), await readFileP(snippetPath));
      manifestFiles.push(`snippet-${safe}.css`);
    } else {
      console.warn(`obsidian css: enabled snippet "${name}" has no file at ${snippetPath}, skipping`);
    }
  }

  // ~/obsidian-kb/obsidian-plugin, not repoRoot: this worktree's repoRoot is .wt/009-perf, a sibling checkout of
  // the zotero-plugin repo, while the Obsidian plugin lives in its own separate repo under the ~/obsidian-kb hub.
  const pluginStylesPath = fileURLToPath(new URL('../../obsidian/styles.css', import.meta.url));
  if (existsSync(pluginStylesPath)) {
    await writeFile(join(cacheDir, 'plugin.css'), await readFileP(pluginStylesPath));
    manifestFiles.push('plugin.css');
  } else {
    console.warn(`obsidian css: plugin styles.css not found at ${pluginStylesPath}, skipping`);
  }

  await writeFile(join(cacheDir, 'manifest.json'), JSON.stringify({ files: manifestFiles, extractedAt: new Date().toISOString() }, null, 2));
  console.log(`obsidian css: manifest has ${manifestFiles.length} file(s): ${manifestFiles.join(', ') || '(none)'}`);
}

// ------------------------------------------------------------------------------------------------------- static server (copied pattern from dev/run.mjs)

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
async function startServer() {
  const server = createServer(async (req, res) => {
    try {
      const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
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
  return server;
}

// ------------------------------------------------------------------------------------------------------- page setup

/** Opens a page against `url`, wires a CDP session (CPU throttling, Performance domain, a `__cdpSample` binding
 *  that returns {recalc, layout} ms delta-since-last-call so perf-common.js's obsidian sampler can approximate
 *  per-update style-recalc/layout cost without a round trip on every single delta), sets --inject-slowdown if
 *  requested, and waits for window.__sbPerfReady. */
async function openPage(browser, url, throttleRate) {
  const page = await browser.newPage();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttleRate });

  let prev = null;
  await page.exposeFunction('__cdpSample', async () => {
    const { metrics } = await cdp.send('Performance.getMetrics');
    const map = Object.fromEntries(metrics.map((m) => [m.name, m.value]));
    const recalcCum = (map.RecalcStyleDuration ?? 0) * 1000;
    const layoutCum = (map.LayoutDuration ?? 0) * 1000;
    const delta = prev ? { recalc: recalcCum - prev.recalc, layout: layoutCum - prev.layout } : { recalc: 0, layout: 0 };
    prev = { recalc: recalcCum, layout: layoutCum };
    return delta;
  });

  const errors = [];
  page.on('response', (res) => {
    if (res.status() >= 400) { const failure = `${res.status()} ${res.url()}`; errors.push(failure); failedRequests.add(failure); }
  });
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });

  if (INJECT_SLOWDOWN) await page.addInitScript(() => { window.__injectSlowdown = true; });

  await page.goto(url);
  await page.waitForFunction(() => window.__sbPerfReady === true, { timeout: 10000 });
  return { page, cdp, errors };
}

// ------------------------------------------------------------------------------------------------------- scenario runners

/** Runs Scenario A `repeats` times on the plain page at `throttle`. Each run is bracketed two ways: (1) a real
 *  Chrome performance trace via `browser.startTracing`/`stopTracing` (Chromium-only, CDP Tracing under the hood --
 *  `page.context().tracing`, used before, silently ignores `categories` and records Playwright's own action-trace
 *  zip instead, not a Chrome trace DevTools can open), kept in memory only long enough to decide which run is
 *  worst (highest renderTotalMs), then written to disk; (2) CDP `Performance.getMetrics` before/after, diffed
 *  into whole-scenario ScriptDuration/TaskDuration/RecalcStyleDuration/LayoutDuration -- the main-thread cost the
 *  weekly budget will actually gate on, as opposed to renderTotalMs/renderP95Ms, which only see wall-clock time
 *  inside ChatView.prototype.paintText itself. */
async function runStreamPlain(browser, baseUrl, throttle, repeats, traceCandidates, harness = 'perf.html') {
  const runs = [];
  for (let i = 0; i < repeats; i++) {
    const { page, cdp, errors } = await openPage(browser, `${baseUrl}/dev/harness/${harness}`, throttle);
    const before = await readMainThreadMetrics(cdp);
    await browser.startTracing(page, { screenshots: false, categories: TRACE_CATEGORIES });
    const result = await page.evaluate((seed) => window.__perfHarness.scenarioA({ seed }), 1000 + i);
    const traceBuf = await browser.stopTracing();
    const after = await readMainThreadMetrics(cdp);
    if (errors.length) console.warn(`streamPlain ${throttle}x rep ${i}: page errors: ${errors.join(' | ')}`);
    const mainThread = diffMainThreadMetrics(before, after);
    runs.push({ ...result, ...mainThread });
    if (traceCandidates) traceCandidates.push({ throttle, renderTotalMs: result.renderTotalMs, traceBuf });
    await page.close();
  }
  return {
    renderTotalMs: stats(runs.map((r) => r.renderTotalMs)),
    renderP95Ms: stats(runs.map((r) => r.renderP95Ms)),
    frameIntervalP95: stats(runs.map((r) => r.frameIntervalP95)),
    framesOver33: stats(runs.map((r) => r.framesOver33)),
    longTasksOver50: stats(runs.map((r) => r.longTasksOver50)),
    mainThreadScriptMs: stats(runs.map((r) => r.scriptMs)),
    mainThreadTaskMs: stats(runs.map((r) => r.taskMs)),
    mainThreadRecalcMs: stats(runs.map((r) => r.recalcMs)),
    mainThreadLayoutMs: stats(runs.map((r) => r.layoutMs)),
  };
}

/** Web first load: navigation start to the first Home row on screen, from a plain static server, the bundle built by
 *  build-web.mjs and the API answered by the canned routes below (no KB server, no network). The page's own
 *  MutationObserver records performance.now() the moment a .sbw-card exists, so Playwright's polling adds nothing. */
const HOUR = 3600_000;
async function runWebFirstLoad(browser, baseUrl, throttle, repeats) {
  const conversations = Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, mode: 'chat', title: `Invented conversation ${i}`, updated: new Date(Date.now() - i * HOUR).toISOString(), artifacts: 0, kind: 'chat' }));
  const runs = [];
  for (let i = 0; i < repeats; i++) {
    const page = await browser.newPage();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
    const errors = [];
    page.on('response', (res) => { if (res.status() >= 400) { const failure = `${res.status()} ${res.url()}`; errors.push(failure); failedRequests.add(failure); } });
    page.on('pageerror', (err) => errors.push(String(err)));
    await page.route(/\/(web|agent|ping|status|zotero|recent)\b/, (route) => {
      const path = new URL(route.request().url()).pathname;
      const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      if (path === '/web/state') return json({ prefs: {}, files: {} });
      if (path === '/agent/conversations') return json(conversations);
      if (path === '/agent/conversations/cursor') return json({ seq: 0, inFlight: false });
      if (path === '/agent/events') return json([]);
      return json(path === '/ping' ? { ok: true } : []);
    });
    await page.addInitScript(() => {
      window.__homeMs = null;
      new MutationObserver((_, observer) => {
        if (document.querySelector('.sbw-card')) { window.__homeMs = performance.now(); observer.disconnect(); }
      }).observe(document, { childList: true, subtree: true });
    });
    await page.goto(`${baseUrl}/dist-web/index.html#/home`);
    await page.waitForFunction(() => window.__homeMs !== null, null, { timeout: 15000 });
    runs.push(await page.evaluate(() => window.__homeMs));
    if (errors.length) console.warn(`webFirstLoad ${throttle}x rep ${i}: page errors: ${errors.join(' | ')}`);
    await page.close();
  }
  return { homeMs: stats(runs) };
}

async function runStreamObsidianCss(browser, baseUrl, throttle, repeats) {
  const runs = [];
  for (let i = 0; i < repeats; i++) {
    const { page, cdp, errors } = await openPage(browser, `${baseUrl}/dev/harness/perf-obsidian.html`, throttle);
    const before = await readMainThreadMetrics(cdp);
    const result = await page.evaluate((seed) => window.__perfHarness.scenarioARecalcLayout({ seed }), 2000 + i);
    const after = await readMainThreadMetrics(cdp);
    if (errors.length) console.warn(`streamObsidianCss ${throttle}x rep ${i}: page errors: ${errors.join(' | ')}`);
    // Each sample covers ~6 updates; dividing by 6 approximates per-update cost (documented in perf-common.js).
    const perUpdateRecalc = result.samples.map((s) => s.recalcMs / 6);
    const perUpdateLayout = result.samples.map((s) => s.layoutMs / 6);
    const mainThread = diffMainThreadMetrics(before, after);
    runs.push({ recalcP95: percentile(perUpdateRecalc, 95), layoutP95: percentile(perUpdateLayout, 95), ...mainThread });
    await page.close();
  }
  return {
    recalcP95Ms: stats(runs.map((r) => r.recalcP95)),
    layoutP95Ms: stats(runs.map((r) => r.layoutP95)),
    mainThreadScriptMs: stats(runs.map((r) => r.scriptMs)),
    mainThreadTaskMs: stats(runs.map((r) => r.taskMs)),
    mainThreadRecalcMs: stats(runs.map((r) => r.recalcMs)),
    mainThreadLayoutMs: stats(runs.map((r) => r.layoutMs)),
  };
}

async function runTyping(browser, baseUrl, throttle, repeats) {
  const runs = [];
  for (let i = 0; i < repeats; i++) {
    const { page, errors } = await openPage(browser, `${baseUrl}/dev/harness/perf.html`, throttle);
    const result = await page.evaluate((seed) => window.__perfHarness.scenarioB({ seed }), 3000 + i);
    if (errors.length) console.warn(`typing ${throttle}x rep ${i}: page errors: ${errors.join(' | ')}`);
    runs.push(result);
    await page.close();
  }
  return {
    eventDelayP95Ms: stats(runs.map((r) => r.eventDelayP95Ms)),
    framesLateP95: stats(runs.map((r) => r.framesLateP95)),
    framesLateMax: stats(runs.map((r) => r.framesLateMax)),
  };
}

async function runScroll(browser, baseUrl, throttle, repeats) {
  const runs = [];
  for (let i = 0; i < repeats; i++) {
    const { page, errors } = await openPage(browser, `${baseUrl}/dev/harness/perf.html`, throttle);
    const result = await page.evaluate((seed) => window.__perfHarness.scenarioC({ seed }), 4000 + i);
    if (errors.length) console.warn(`scroll ${throttle}x rep ${i}: page errors: ${errors.join(' | ')}`);
    runs.push(result);
    await page.close();
  }
  return {
    pausedAfterScrollUp: runs.every((r) => r.pausedAfterScrollUp),
    resumedAtEnd: runs.every((r) => r.resumedAtEnd),
    framesOver33: stats(runs.map((r) => r.framesOver33)),
  };
}

async function runLeak(browser, baseUrl, throttle, repeats) {
  const runs = [];
  for (let i = 0; i < repeats; i++) {
    const { page, cdp, errors } = await openPage(browser, `${baseUrl}/dev/harness/perf.html`, throttle);
    const gc = async () => { for (let g = 0; g < 3; g++) await cdp.send('HeapProfiler.collectGarbage'); };
    await gc();
    const before = (await cdp.send('Runtime.getHeapUsage')).usedSize;
    await page.evaluate((seed) => window.__perfHarness.scenarioD({ seed, iterations: 20 }), 5000 + i);
    await gc();
    const after = (await cdp.send('Runtime.getHeapUsage')).usedSize;
    if (errors.length) console.warn(`leak ${throttle}x rep ${i}: page errors: ${errors.join(' | ')}`);
    runs.push((after - before) / (1024 * 1024));
    await page.close();
  }
  return { growthMB: stats(runs) };
}

async function runFirstRender(browser, baseUrl, throttle, repeats) {
  const runs = [];
  for (let i = 0; i < repeats; i++) {
    const { page, errors } = await openPage(browser, `${baseUrl}/dev/harness/perf.html`, throttle);
    const result = await page.evaluate(() => window.__perfHarness.scenarioE());
    if (errors.length) console.warn(`firstRender ${throttle}x rep ${i}: page errors: ${errors.join(' | ')}`);
    runs.push(result.ms);
    await page.close();
  }
  return { ms: stats(runs) };
}

// ------------------------------------------------------------------------------------------------------- main

function printTable(scenarios) {
  const rows = [];
  for (const [scenario, byThrottle] of Object.entries(scenarios)) {
    for (const [throttle, metrics] of Object.entries(byThrottle)) {
      for (const [metric, v] of Object.entries(metrics)) {
        if (v && typeof v === 'object' && 'median' in v) rows.push([scenario, throttle, metric, `${v.median} [${v.min}-${v.max}]`]);
        else rows.push([scenario, throttle, metric, String(v)]);
      }
    }
  }
  const widths = [0, 0, 0, 0];
  for (const r of rows) r.forEach((c, i) => { widths[i] = Math.max(widths[i], String(c).length); });
  console.log(['scenario', 'throttle', 'metric', 'median [min-max]'].map((h, i) => h.padEnd(widths[i])).join('  '));
  for (const r of rows) console.log(r.map((c, i) => String(c).padEnd(widths[i])).join('  '));
}

async function main() {
  // the web rows measure the bundle as it is now, so build it here rather than trust a stale dist-web/
  await execFileP('npm', ['run', '--silent', 'build'], { cwd: webRoot });
  await extractObsidianCss();
  const server = await startServer();
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const browser = await chromium.launch(process.env.SB_BROWSER ? { executablePath: process.env.SB_BROWSER } : {}); // headless by default; never pass headless:false here. SB_BROWSER: an installed Chrome when Playwright's download is absent (same as dev/run.mjs)
  const throttles = [1, 4];
  const scenarios = { streamPlain: {}, streamObsidianCss: {}, typing: {}, scroll: {}, leak: {}, firstRender: {}, streamWeb: {}, webFirstLoad: {} };
  const traceCandidates = [];

  for (const throttle of throttles) {
    const key = `${throttle}x`;
    console.log(`\n=== throttle ${key} ===`);
    scenarios.streamPlain[key] = await runStreamPlain(browser, baseUrl, throttle, REPEATS, traceCandidates);
    scenarios.streamObsidianCss[key] = await runStreamObsidianCss(browser, baseUrl, throttle, REPEATS);
    scenarios.typing[key] = await runTyping(browser, baseUrl, throttle, REPEATS);
    scenarios.scroll[key] = await runScroll(browser, baseUrl, throttle, REPEATS);
    scenarios.leak[key] = await runLeak(browser, baseUrl, throttle, REPEATS);
    scenarios.firstRender[key] = await runFirstRender(browser, baseUrl, throttle, REPEATS);
    scenarios.streamWeb[key] = await runStreamPlain(browser, baseUrl, throttle, REPEATS, null, 'perf-web.html');
    scenarios.webFirstLoad[key] = await runWebFirstLoad(browser, baseUrl, throttle, REPEATS);
  }

  await browser.close();
  server.close();

  // Worst Scenario A run (highest total render ms) gets its Chrome trace saved, gzipped, next to the JSON output.
  if (traceCandidates.length) {
    const worst = traceCandidates.reduce((a, b) => (b.renderTotalMs > a.renderTotalMs ? b : a));
    const gz = gzipSync(worst.traceBuf);
    const traceOut = OUT.replace(/\.json$/, '') + '.trace.json.gz';
    await writeFile(traceOut, gz);
    console.log(`\nsaved worst-run trace (${worst.throttle}x, ${worst.renderTotalMs}ms render, ${worst.traceBuf.length} raw bytes) to ${traceOut}`);
  }

  let sha = 'unknown';
  try { sha = (await execFileP('git', ['rev-parse', '--short', 'HEAD'], { cwd: root })).stdout.trim(); } catch { /* not fatal */ }

  const report = {
    sha,
    date: new Date().toISOString(),
    machine: {
      load: os.loadavg(),
      freeMem: os.freemem(),
      cpu: `${os.cpus()[0]?.model ?? 'unknown'} x${os.cpus().length}`,
    },
    repeats: REPEATS,
    injectSlowdown: INJECT_SLOWDOWN,
    scenarios,
  };

  report.failedRequests = [...failedRequests];
  await mkdir(join(OUT, '..'), { recursive: true }).catch(() => {});
  await writeFile(OUT, JSON.stringify(report, null, 2));
  console.log(`\nwrote ${OUT}`);
  printTable(scenarios);
  if (failedRequests.size) {
    console.error(`\nFAILED: ${failedRequests.size} request(s) returned HTTP >= 400:\n  ${[...failedRequests].join('\n  ')}`);
    process.exit(1);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
