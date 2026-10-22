# Plan: 006 auto-update

Units are built and verified in order. Each unit's own verification must pass before the next starts.

## U1 — Server: plugin-update routes

Add to `http_api.py` (new small module `plugin_updates.py` to keep http_api.py thin):
- `latest_zotero_xpi(dist_dir) -> {version, sha256, filename} | None` — scans `zotero-plugin/dist/second-brain-*.xpi`,
  picks the highest by parsed semver (not mtime).
- `latest_obsidian_build(dist_root) -> {version, files: {name: sha256}} | None` — reads
  `obsidian-plugin/dist-versions/<version>/{main.js,manifest.json,styles.css}`, picks highest semver dir that has
  all three files.
- `lockstep_version(dist_dir_zotero, dist_root_obsidian) -> str | None` — the highest version present in BOTH.
- Routes (GET, token-checked like the rest, NOT in AGENT_ROUTES):
  - `/plugins/zotero/latest` → `{version, sha256, url}` for the lockstep version, 404 if none.
  - `/plugins/zotero/xpi?version=` → streams that xpi if it equals the lockstep version, else 404.
  - `/plugins/obsidian/latest` → `{version, files: {name: sha256}}` for the lockstep version.
  - `/plugins/obsidian/file?version=&name=` → streams that file if version is lockstep and name is one of the
    three allowed names, else 404.
- Back up `http_api.py` to `data/http_api.py.bak-before-006` before editing.

**Verify:** curl all four routes with the token against the running server (after U2 produces a real
`dist-versions/0.24.0/` from the current build). Show output. Confirm a request for a non-lockstep version 404s.

## U2 — Build side: obsidian-plugin publishes a versioned build

Edit `obsidian-plugin/install.sh`: after building, also copy `main.js`, `manifest.json`, `styles.css` into
`~/obsidian-kb/obsidian-plugin/dist-versions/<version>/` (version read from manifest.json). This directory is
what U1's server route reads — building = publishing, no separate step.

**Verify:** run `install.sh`, confirm `dist-versions/0.24.0/` has the three files and matches what's installed.

## U3 — Zotero plugin: updater module

New `content/updater.js` (loaded from bootstrap.js), `SecondBrain.Updater`:
- Pref `extensions.secondbrain.updates`: default unset → treated as `"github"`. Never overwritten by code; only
  set through the settings UI (radio, like `sb-notes-in`) so a public install's real prefs.js is never touched
  by me.
- When pref is `"server"`: `check()` calls `GET {server}/plugins/zotero/latest`, compares semver against
  `manifest.json`'s version (Zotero's own `install.version`), and the addon id must match
  `second-brain@frimpsjoe.local`. Refuses (log + return) if not newer, or id differs.
- `idle()`: true when `this.sb.agent.busy === 0` (no streaming turn) and no open editor has `dirty || saving`
  (`this.sb.editors`) and no plan/report field has focus (`doc.activeElement.closest('[contenteditable]')` check
  across all main windows for `.sb-rp-*` field elements — the report plan uses `contenteditable="plaintext-only"`
  in ReportView, ui-src/src/chat/report-view.js:127).
- On idle + newer version: download xpi to a temp file (`IOUtils`), verify sha256, then
  `AddonManager.getInstallForFile(file)` → `install.install()`.
- Cache invalidation: after `install()` resolves, call `Services.obs.notifyObservers(null, "startupcache-invalidate")`
  (the documented API replacement for `-purgecaches` at runtime) before Zotero's own `shutdown()`/`startup()` cycle
  runs. Log whether the notification fired.
- Timers: check at startup (after `Zotero.uiReadyPromise`), then every 15 min (`setInterval`); if busy, retry every
  60 s until idle, without resetting the 15-min clock.
- One quiet notice via `Zotero.log`/a passive UI affordance — spec says "one quiet notice" but Zotero has no
  passive toast API guaranteed cross-version; use `Zotero.alert`-free progress window
  (`new Zotero.ProgressWindow` with `.startCloseTimer()`, matching how the rest of the plugin already reports
  background work) titled "Second Brain updated to X".
- `checkNow()` for the settings button, returns a status string the UI shows inline (not a dialog).

Wire into `second-brain.js`: `this.updater = new this.Updater(this)` in `init()`, `this.updater.start()`;
`this.updater.stop()` in `shutdown()`.

Settings UI (`preferences.xhtml`/`preferences.js`): a "Updates" groupbox with a radiogroup
(server / github / off) mirroring `sb-notes-in`, plus a "Check for updates" button and a status line, matching
the existing pattern exactly (see `sb-server`/`this.check`).

**Verify:** `node --check content/updater.js` (syntax) since there's no JS unit-test harness for Zotero chrome
code outside the headless harness; the real verification is U6.

## U4 — Obsidian plugin: updater module

New `src/updater-core.ts`: pure, obsidian-import-free functions, unit-testable with plain `node`:
- `isNewer(current: string, candidate: string): boolean` (semver compare)
- `pickIdleOk(state: {busy: number; dirtyEditors: boolean; planFieldFocused: boolean}): boolean`
- `verifySha256(data: ArrayBuffer, expected: string): Promise<boolean>` (Node's `crypto.subtle` / `node:crypto`)

New `src/updater.ts` (obsidian-facing): `PluginUpdater` class wired into `main.ts`:
- Setting `updates: "server" | "off"` (default `"server"`) added to `Settings`/`DEFAULTS` in `api.ts`.
- `check()`: `GET /plugins/obsidian/latest` via `this.api.call`, compare with `manifest.json` version bundled in
  the plugin (read via `this.manifest.version`, which Obsidian gives every plugin).
- Idle: no chat turn streaming (`ChatView` exposes a `running` flag already used for the send button state —
  reuse it), no `MarkdownView` with unsaved changes (Obsidian doesn't expose "dirty" directly; use
  `this.app.workspace.getActiveViewOfType(MarkdownView)` + check `view.leaf.getViewState().state?.mode` is not
  mid-edit is unreliable, so instead: no editor holds focus (`document.activeElement` not inside `.cm-editor`) —
  matches the spec's "no unsaved note editor text" intent conservatively (treats "focused editor" as busy)),
  and no report plan field focused (`document.activeElement.closest('[contenteditable]')`).
- On idle + newer: `GET /plugins/obsidian/file?version=&name=` for each of the 3 files, verify sha256 with
  `updater-core.verifySha256`, write via `app.vault.adapter.write` (binary via `writeBinary` for main.js/styles.css
  as text is fine as UTF-8 for JS/CSS; manifest.json as text) into the plugin's own directory
  (`this.app.vault.configDir + "/plugins/second-brain-search/"`), refuse if any file's hash mismatches (abort
  before writing any file — verify all three first, write all three only if all verify), then when idle
  `this.app.plugins.disablePlugin(id)` + `enablePlugin(id)`, then one `new Notice("Second Brain updated to " + v)`.
  `data.json` is never touched (not in the file list).
- 15-min `registerInterval`, plus check at `onload` (after `onLayoutReady`), plus a "Check for updates" button in
  `SettingsTab`.
- Refusals (older/same version, id mismatch — N/A for Obsidian, no id field — bad sha256) are `console.warn`-logged
  with a `[second-brain-updater]` prefix.

**Verify:**
1. `npx tsc -p .` → 0 lines.
2. `node --experimental-strip-types --test src/updater-core.test.ts` — pure-logic unit tests: semver comparisons
   (including equal, older, pre-release-like strings), idle decision table, sha256 verify (good + tampered).
3. A second test, `src/updater.test.ts`, using a fake `adapter`/`fetch` (no real Obsidian) to drive `PluginUpdater`
   end-to-end against an in-memory server double: confirms it writes files only when all three hashes verify,
   refuses an older/equal version, and does not write on a single bad hash.

## U5 — Version bump + build

Bump both `manifest.json` files to `0.25.0`. Run `zotero-plugin/build.sh` (produces
`dist/second-brain-0.25.0.xpi` + updated `dist/update.json`, unchanged mechanism) and
`obsidian-plugin/install.sh` (builds + installs into the user's real vault + publishes
`dist-versions/0.25.0/`, per the user's existing expectation that finished work is always installed — but the
Zotero xpi is NOT installed into the user's real Zotero profile and Zotero is not restarted, per the task's
explicit instruction).

**Verify:** `ls dist/second-brain-0.25.0.xpi`, `ls dist-versions/0.25.0/`, re-curl U1's routes and confirm they now
report `0.25.0`.

## U6 — Zotero headless harness test

New `agent-src/dev/zotero-harness/tests/t-auto-update.js`:
1. `harness.sh setup` a scratch dir; `SB_SERVER` points at a tiny fixture HTTP server (Python, started by the
   test's shell wrapper) that serves fixture `/plugins/zotero/latest` + `/plugins/zotero/xpi` for a fabricated
   version N+1 xpi built from the current source tree with the manifest version bumped — never touching the real
   `dist/`.
2. Install version N (the harness's normal xpi), start Zotero, confirm `Zotero.SecondBrain.version === N`.
3. Point the fixture server at N+1, call `Zotero.SecondBrain.updater.checkNow()`, wait for install, then re-probe
   `Zotero.SecondBrain.version === N+1` — proves live code, not just "looked installed."
4. Repeat with the chat mid-stream (fake a `busy++` before checking) — confirm the updater logs "waiting: busy"
   and does not install until `busy` returns to 0.
5. Repeat with a corrupted sha256 in the fixture's `/latest` response — confirm refusal, version stays N, and a
   log line records the refusal.

Clean up: `harness.sh stop`, remove the scratch dir and fixture xpi from `/tmp/sb-harness*` afterward (disk is
~9.5 GB free).

**Verify:** `harness.sh run <dir> tests/t-auto-update.js` prints `DONE pass=N fail=0`.

## U7 — curl proof + commits

curl every U1 route (with the real token) against the running server at 0.25.0 lockstep and paste output in the
final report.

Commit each unit locally as it lands (zotero-plugin repo for U1/U3/U5-zotero-part/U6; obsidian-plugin repo,
committed with `git -C ../zotero-plugin config user.email/user.name`, for U2/U4/U5-obsidian-part). Message suffix
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` per instruction.
