# Spec: Auto-update for the Zotero and Obsidian plugins

Status: APPROVED by the user 2026-09-26; build after spec 005 units A–C land (both touch the same files).

## Problem

Every new build today needs a manual step before the user sees it: quit Zotero, copy the xpi into the profile,
reopen with `-purgecaches`; in Obsidian, toggle Second Brain Search off and on. Twice today the user looked at
an old version and thought the new work was missing. The phone's Obsidian can't be updated from the Mac at all.

Zotero already checks `update_url` (GitHub `releases/latest/download/update.json`), but only public tagged releases
reach it, only on Zotero's own schedule, and it applies the update at the next restart.

## Goals

1. A new build reaches the user's running Zotero and Obsidian (Mac and phone) within a few minutes, with no restart,
   no toggle and no copy step.
2. Updates never interrupt work: never mid-answer or mid-report-plan edit, never steal focus, never open a window.
3. After an update, one quiet notice: "Second Brain updated to 0.24.0". Nothing else.
4. People installing from the public GitHub repo keep getting GitHub releases, as today.

## Non-goals

Obsidian community-plugin store listing; code signing; update channels beyond "local server" and "GitHub".

## Design

**Source of builds: the Second Brain server** (`kb.py serve`, 127.0.0.1:27182, and the phone over Tailscale with
its bearer token).
- `GET /plugins/zotero/latest` → `{ version, sha256, url }` for the newest `zotero-plugin/dist/second-brain-*.xpi`
  (by semver, not mtime); `GET /plugins/zotero/xpi?version=` streams it.
- `GET /plugins/obsidian/latest` → `{ version, files: { "main.js": sha256, "manifest.json": …, "styles.css": … } }`
  from `obsidian-plugin/` build output; `GET /plugins/obsidian/file?name=` streams one file.
- Read-only, token-checked like the other routes; not in `AGENT_ROUTES` (agents don't need it).

**Zotero** (bootstrapped plugin, so an install applies live):
- Pref `extensions.secondbrain.updates`: `"server"` (the user's machine) | `"github"` (default for public installs,
  = today's `update_url`, unchanged) | `"off"`.
- With `"server"`: check at startup and every 15 min. If newer: download to a temp file, verify sha256,
  `AddonManager.getInstallForFile(file)` → `install()` once idle. Zotero calls the old `shutdown()` and the new
  `startup()` in place; open chat tabs are re-created by the new code with their conversation reopened.
- Idle = no chat turn streaming, no report plan being edited (focus in a plan field), no note editor with unsaved
  text. If busy, retry every minute.
- Must also clear the startup cache for the plugin's chrome files, the reason `-purgecaches` was needed. Verify in
  the harness that new code actually runs after a live install (the 0.12 "looked installed but wasn't" trap).

**Obsidian** (Mac and phone):
- Setting "Updates: from my Second Brain server / off", default server.
- Check at load and every 15 min. If newer: download each changed file, verify sha256, write with
  `app.vault.adapter.write` into `.obsidian/plugins/second-brain-search/`, then when idle
  `app.plugins.disablePlugin(id)` + `enablePlugin(id)`; open views are restored by Obsidian's workspace layout.
- Idle rule as for Zotero (no streaming turn, no plan edit).
- `data.json` (settings) is never touched.

**Build side:** `install.sh` / `build.sh` stay as they are; the server serves whatever is newest in the dist
folders, so building is publishing. A broken build is caught by the checks that already gate a build (tsc, tests);
the plugin also refuses a file whose manifest `id` differs or whose version isn't strictly newer.

## Success checks

1. Build a new Zotero xpi → the running (harness) Zotero runs the new code within 15 min, without restart; a
   `Zotero.SecondBrain.version` probe reports the new version.
2. Same while a chat answer streams → the install waits until it finishes.
3. Build a new Obsidian version → running Obsidian reloads the plugin within 15 min and shows one notice;
   settings are unchanged.
4. The phone picks up the same Obsidian build over Tailscale.
5. A tampered file (bad sha256) or an older version is refused and logged, nothing changes.
6. A public install with the default pref still uses GitHub `update.json` only; nothing calls 127.0.0.1.
7. No focus change during any update (frontmost app unchanged).

## Decisions (user, 2026-09-26)

1. Check every 15 min, plus a "Check for updates" button in each plugin's settings.
2. Lockstep: one shared-UI version; Zotero and Obsidian ship the same version number and update together
   (the server only offers a version once both builds for it exist).
