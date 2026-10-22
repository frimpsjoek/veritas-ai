import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ICONS } from '../src/icons.js';
import { ROWS, SECTIONS, WALL_CLOCK_DEFAULT_MINUTES, patchFor, readRow, sidebarSections, visibleSections, writeRow } from '../src/settings/settings-schema.js';
import { DEFAULT_RESEARCH, DEFAULT_LOCAL, DEFAULT_TURN_WALL_CLOCK_MS, defaultSettings } from '../../agent-src/src/settings.js';

const ids = (groups) => groups.flatMap((g) => g.rows.map((r) => r.id));

test('sections come in the approved order and each has an icon that exists', () => {
  assert.deepEqual(SECTIONS.map((s) => s.label), ['General', 'Models', 'On this Mac', 'Research', 'Finding papers', 'Reading radar', 'Routines', 'Sources and tools', 'Folders', 'Search index', 'Server and phone', 'About']);
  for (const s of SECTIONS) assert.match(ICONS[s.icon] ?? '', /^M/, `icon ${s.icon}`);
  for (const r of ROWS) assert.ok(SECTIONS.some((s) => s.id === r.section), `${r.id} names a real section`);
  assert.equal(new Set(ROWS.map((r) => r.id)).size, ROWS.length, 'row ids are unique');
});

// The old web Settings (pages.js paintSettings): Appearance, Use on your phone, Models, Finding papers online (OpenAlex key), Search index.
test('every row of the old web Settings has a row in the table', () => {
  const web = ids(visibleSections({ host: 'web', advanced: Object.fromEntries(SECTIONS.map((s) => [s.id, true])), section: null }));
  for (const old of ['general.theme', 'server.phone', 'models.main', 'papers.openalex', 'index.status']) assert.ok(web.includes(old), `${old} shows on the web`);
});

test('every old Zotero and Obsidian row is in the table for its host', () => {
  const all = { advanced: Object.fromEntries(SECTIONS.map((s) => [s.id, true])), section: null };
  const zotero = ids(visibleSections({ host: 'zotero', ...all }));
  for (const old of ['general.notesIn', 'general.notesFolder', 'general.colors', 'index.model', 'papers.email', 'papers.openalex', 'papers.unpaywall', 'papers.s2', 'papers.test', 'server.vault', 'server.addressZotero', 'general.updatesZotero', 'about.update', 'research.web', 'mac.scanDirs', 'mac.idleMinutes', 'mac.allowReports', 'sources.mcp']) {
    assert.ok(zotero.includes(old), `${old} shows in Zotero`);
  }
  const obsidian = ids(visibleSections({ host: 'obsidian', ...all }));
  for (const old of ['server.start', 'server.kbDir', 'server.python', 'server.port', 'server.phone', 'server.addressObsidian', 'general.updatesObsidian', 'about.update', 'index.open', 'general.copyDepth', 'general.copySimilar', 'research.web', 'papers.openalex', 'mac.scanDirs', 'sources.mcp']) {
    assert.ok(obsidian.includes(old), `${old} shows in Obsidian`);
  }
  const mobile = ids(visibleSections({ host: 'obsidian', platform: 'mobile', ...all }));
  assert.ok(mobile.includes('server.token') && mobile.includes('server.test') && !mobile.includes('server.start'), 'the phone shows the token, not the server switch');
});

test('search finds the OpenAlex key and the parallel researchers, even when advanced rows are hidden', () => {
  const openalex = visibleSections({ host: 'web', query: 'OpenAlex' });
  assert.ok(ids(openalex).includes('papers.openalex'));
  assert.deepEqual(openalex.map((g) => g.section.id).filter((id) => id === 'papers'), ['papers'], 'the hit comes with its section header');
  const parallel = visibleSections({ host: 'web', query: 'parallel' });
  assert.deepEqual(ids(parallel), ['research.concurrency']);
  assert.equal(parallel[0].section.id, 'research');
  assert.deepEqual(visibleSections({ host: 'web', query: 'zzzz-nothing' }), []);
});

test('advanced rows stay hidden until the section switch is on', () => {
  const closed = visibleSections({ host: 'web', section: 'research' });
  assert.deepEqual(ids(closed), ['research.web']);
  assert.ok(closed[0].hiddenAdvanced >= 10, 'the switch says how many are waiting');
  const open = ids(visibleSections({ host: 'web', section: 'research', advanced: { research: true } }));
  assert.ok(open.includes('research.concurrency') && open.includes('research.minutes.writer') && open.includes('research.toolCalls'));
  // the switch is per section: opening Research does not open On this Mac
  assert.deepEqual(ids(visibleSections({ host: 'web', section: 'mac', advanced: { research: true } })), ['mac.scanDirs', 'mac.idleMinutes', 'mac.allowReports']);
  assert.ok(ids(visibleSections({ host: 'web', section: 'mac', advanced: { mac: true } })).includes('mac.python'));
  assert.ok(ids(visibleSections({ host: 'web', section: 'mac', advanced: { mac: true } })).includes('mac.external'));
});

test('Zotero-only rows are hidden on the web, and a row with no way to draw it is hidden too', () => {
  const web = ids(visibleSections({ host: 'web', section: null, advanced: Object.fromEntries(SECTIONS.map((s) => [s.id, true])) }));
  for (const zoteroOnly of ['general.colors', 'general.notesIn', 'papers.email', 'papers.unpaywall', 'server.vault', 'index.model']) assert.ok(!web.includes(zoteroOnly), `${zoteroOnly} must not show on the web`);
  const supported = ids(visibleSections({ host: 'web', section: 'about', supports: (r) => r.kind !== 'action' }));
  assert.deepEqual(supported, ['about.version']);
  assert.ok(sidebarSections('web').length === SECTIONS.length);
});

test('every engine row points at a real setting, and the defaults agree with the engine', () => {
  const settings = defaultSettings();
  for (const row of ROWS.filter((r) => r.store === 'engine')) {
    const value = readRow(row, { prefs: { get: () => undefined }, settings });
    if (row.def != null) assert.equal(value, row.def, `${row.id} default matches the engine`);
  }
  assert.deepEqual(Object.fromEntries(Object.entries(DEFAULT_TURN_WALL_CLOCK_MS).map(([k, v]) => [k, v / 60000])), WALL_CLOCK_DEFAULT_MINUTES);
  for (const [k, v] of Object.entries(DEFAULT_RESEARCH)) assert.equal(ROWS.find((r) => r.key === `research.${k}`)?.def, v, `research.${k}`);
  for (const k of ['idleMinutes', 'allowReports', 'external']) assert.equal(ROWS.find((r) => r.key === `local.${k}`)?.def, DEFAULT_LOCAL[k], `local.${k}`);
});

test('every engine setting the old Settings let you change, plus the ones that had no UI, has a row', () => {
  const keys = new Set(ROWS.map((r) => r.key));
  for (const k of ['webSearchDefault', 'research.askFirstRows', 'research.askFirstCells', 'research.maxRows', 'research.concurrency', 'turnLimits.toolCallBudget', 'local.scanDirs', 'local.idleMinutes', 'local.allowReports', 'local.python', 'local.external']) assert.ok(keys.has(k), k);
  for (const role of ['chat', 'ask', 'lead', 'researcher', 'writer', 'extract']) assert.ok(keys.has(`turnLimits.wallClockMs.${role}`), role);
});

test('writing a row builds the right patch, in the engine and in prefs', () => {
  assert.deepEqual(patchFor('turnLimits.wallClockMs.chat', 1), { turnLimits: { wallClockMs: { chat: 1 } } });
  const minutes = ROWS.find((r) => r.id === 'research.minutes.writer');
  assert.deepEqual(writeRow(minutes, '10'), { engine: { turnLimits: { wallClockMs: { writer: 600000 } } } });
  assert.equal(writeRow(minutes, '0'), null, 'below the minimum is refused');
  assert.equal(writeRow(minutes, 'abc'), null);
  assert.equal(writeRow(ROWS.find((r) => r.id === 'research.concurrency'), '9'), null, 'never above 6');
  assert.deepEqual(writeRow(ROWS.find((r) => r.id === 'research.toolCalls'), ''), { engine: { turnLimits: { toolCallBudget: null } } }, 'emptied goes back to the built-in limit');
  assert.deepEqual(writeRow(ROWS.find((r) => r.id === 'mac.scanDirs'), ' /a \n\n/b '), { engine: { local: { scanDirs: ['/a', '/b'] } } });
  assert.deepEqual(writeRow(ROWS.find((r) => r.id === 'mac.python'), '  '), { engine: { local: { python: null } } });
  assert.deepEqual(writeRow(ROWS.find((r) => r.id === 'general.theme'), 'dark'), { prefs: ['webTheme', 'dark'] });
  assert.deepEqual(writeRow(ROWS.find((r) => r.id === 'general.copyDepth'), '2'), { prefs: ['contextDepth', 2] });
  assert.deepEqual(writeRow(ROWS.find((r) => r.id === 'papers.email'), ''), { prefs: ['email', undefined] }, 'an emptied text pref is cleared');
  const state = { prefs: { get: () => undefined }, settings: { turnLimits: { wallClockMs: { writer: 600000 } } } };
  assert.equal(readRow(minutes, state), 10);
  assert.equal(readRow(ROWS.find((r) => r.id === 'research.minutes.chat'), state), 5, 'unset shows the default');
});

test('Open links is a General row for the web app and Obsidian, only where links can open inside the app', async () => {
  const { rowAllowed } = await import('../src/settings/settings-schema.js');
  const row = ROWS.find((r) => r.id === 'general.openLinks');
  assert.ok(row);
  assert.deepEqual([row.section, row.key, row.def, row.options.map(([v]) => v)], ['general', 'openLinks', 'inside', ['inside', 'outside']]);
  assert.ok(ids(visibleSections({ host: 'web', section: 'general' })).includes('general.openLinks'));
  assert.ok(ids(visibleSections({ host: 'obsidian', section: 'general' })).includes('general.openLinks'));
  assert.ok(!ids(visibleSections({ host: 'zotero', section: 'general' })).includes('general.openLinks'), 'Zotero has no browser inside');
  assert.equal(rowAllowed(row, { linksInside: true }), true);
  assert.equal(rowAllowed(row, { linksInside: false }), false);
  assert.equal(rowAllowed(row, undefined), false);
  assert.equal(rowAllowed(ROWS.find((r) => r.id === 'general.theme'), undefined), true, 'a row with no requirement always shows');
});

test('the Open links choice is written under the key links.js reads', async () => {
  const { linkMode } = await import('../src/links.js');
  const row = ROWS.find((r) => r.id === 'general.openLinks');
  const store = new Map();
  const prefs = { get: (k) => store.get(k) };
  assert.equal(linkMode(prefs), 'inside', 'nothing stored means inside');
  const write = writeRow(row, 'outside');
  assert.deepEqual(write, { prefs: ['openLinks', 'outside'] });
  store.set(...write.prefs);
  assert.equal(linkMode(prefs), 'outside');
  assert.equal(readRow(row, { prefs, settings: {} }), 'outside');
});
