# Plan: spec 024, task groups after G1 (written 2026-10-28)

Each task group runs in its own git worktree and branch, by one agent, and is merged into `main` after `./check.sh`
passes. Pushes, Homebrew installs and tool installs (Rust, PyInstaller) are gates the user confirms.

| TG | Branch | Covers | Owns (no other TG edits these) |
|---|---|---|---|
| 1 | `ai/024-g2-platforms` | G2 | `server/zotero_files.py`, `server/sources.py`, `server/pdf_route.py`, `server/media.py`, `agent/src/secrets.js`, `.github/workflows/check.yml`, Settings "On this computer" texts |
| 2 | `ai/024-g3-desktop` | G3 (unsigned, model on first start) | new `app/` (Tauri), `packaging/pyinstaller/`, `packaging/sea/`, `.github/workflows/release-app.yml`, `docs/guide/install-desktop.md` |
| 3 | `ai/024-g4-updates` | G4 | `.github/workflows/release.yml`, `tools/release.mjs`, `packaging/homebrew/`, `docs/guide/updating.md`, README install/update sections |
| 4 | `ai/024-fixes` | deferred review minors (ledger) | the files each fix names; nothing in the tables above |

## TG1: runs on Windows and Linux
1. Zotero profile per system (`%APPDATA%\Zotero\Zotero\Profiles`, `~/.zotero/zotero`, macOS as today), with tests.
2. OCR: Vision on macOS; Tesseract (`pytesseract` or the `tesseract` binary) elsewhere when installed; else text-layer PDFs
   only, and the Settings row says so. "On this Mac" → "On this computer".
3. Keys: Keychain on macOS; Windows Credential Manager and Linux Secret Service through `keyring`-equivalent calls in the
   agent (`secrets.js`) and the server (`zotero_web.py`); the owner-only file when none is usable. Tests per system (mocked).
4. Paths, `~`, line endings, process spawning (`SECOND_BRAIN_NODE`, agentd) checked; `bin/veritas` gets a `veritas.cmd`/
   PowerShell twin or a Node entry so Windows has a command too.
5. `check.yml` runs on `ubuntu-latest`, `macos-latest`, `windows-latest`.
- [ ] Done when `./check.sh` is green locally and the three CI jobs are defined and pass on a push (push = user gate).

## TG2: desktop app (Tauri, unsigned)
1. `app/`: Tauri 2 shell loading `web/dist-web` from the bundled server (`http://127.0.0.1:<port>/app/`), Veritas icon,
   tray icon, "start at login", window state remembered.
2. Sidecars: server as one PyInstaller executable (`packaging/pyinstaller/veritas-server.spec`, onnxruntime, tantivy,
   pdfium; MLX excluded off-macOS), agent as a Node SEA executable; the app starts both on a free port, stops them on quit,
   points `VERITAS_DATA` at the OS app-data folder.
3. First start: downloads the search model (133 MB, progress shown), then opens the guided setup (spec 023).
4. Tauri updater against GitHub Releases, minisign keypair (public key in `tauri.conf.json`; private key = user gate, kept
   out of git), asks before installing.
5. `release-app.yml`: builds `.dmg`, `-Setup.exe`, `.AppImage` + `.deb` on the three runners per tag; unsigned; install
   notes for Gatekeeper ("Open Anyway") and SmartScreen in `docs/guide/install-desktop.md`; sizes recorded in spec.md.
6. Local build on this Mac → `Veritas.dmg`; the user installs it (gate).
- [ ] Done when the local `.dmg` opens, starts the sidecars, downloads the model, shows guided setup, chat answers.

## TG3: updates stay easy
1. `release.yml` on tag `v*`: runs `check.sh`, attaches `veritas-zotero-<v>.xpi` + `update.json`, bumps the tap formula
   (url + sha256) in `frimpsjoek/homebrew-veritas` with a PAT secret `HOMEBREW_TAP_TOKEN` (user adds the secret = gate).
2. `tools/release.mjs <version>`: bumps every part's version in lockstep (agent, ui, web, obsidian, zotero manifest +
   update.json, formula comment, app `tauri.conf.json`), writes the CHANGELOG stub, commits and tags; never pushes.
3. `brew upgrade` path checked: `post_install` refreshes the web app and venv; the service restarts; data untouched.
4. `docs/guide/updating.md` + README: how each install updates (brew, app, plugins).
- [ ] Done when a dry run of `tools/release.mjs` on a scratch branch produces the right diffs and `check.sh` is green.

## TG4: deferred review minors (from the SDD ledger)
- Keychain write passes the key on argv (`server/zotero_web.py`): use `security -i` on stdin (the file says it does; check).
- `add_account` accepts a `user_id` already listed; Keychain failure → 500 not 400.
- disabled online default library silently falls back to the local queue → say so in the response.
- chat mirror lists `chats/` on every append → cache the listing.
- listed folder subfolder named `zotero/` unreadable via `<name>:/zotero/x.md`.
- `check.sh` regenerates tracked `obsidian/styles.css` (drift) → build to a temp file and compare.
- `server/requirements.txt` lacks `mcp` (server.py entry point).
- `zotero/package.json` `"type": "module"` vs CJS tooling → check the build scripts still parse.
- Each fix: failing test first, smallest change, `./check.sh`.
- [x] Done when every item has a commit or a written reason to leave it.

### TG4 evidence (2026-10-28, branch ai/024-fixes)
1. Keychain write on argv: already fixed in b5e127f (`security -i`, command on stdin, key letters and digits only).
   Added 33cf428: a fake `security` on PATH records argv (`-i` only) and stdin (the add command with the key),
   and its exit 44 becomes a ZoteroWebError. `security -i` returns non-zero when the inner command fails
   (checked with a read-only `find-generic-password` on a missing item: rc 44), so failures are not swallowed.
2. `add_account` duplicate user / Keychain failure: already fixed in b5e127f, in sources.py (no patch file needed).
   A listed user_id is refused with 409 (the same code /sources uses for a duplicate folder), a Keychain failure
   is a 400 with its reason; test_add_account_refuses_a_listed_user_and_reports_keychain_failure.
3. Switched-off online default library: already fixed in b5e127f (pending_adds: the add fails with "the default
   library <name> is switched off ..."; nothing queued locally); test_switched_off_online_default_says_so.
4. Chat mirror listing: 2b6b01a. The store remembers each chat's mirror name; the folder is listed only on a
   chat's first write in this process or after a rename (and on remove). Test RED (lists counted) -> GREEN.
5. `<name>:/zotero/x.md`: already fixed in b5e127f (kb.note_path: a Zotero item key wins, else a listed folder's
   own subfolder named zotero/ is an ordinary note path); test_listed_folder_subfolder_named_zotero_is_a_note.
6. check.sh and obsidian/styles.css: ab10f92. esbuild.config.mjs writes to `STYLES_OUT` when set; check.sh builds
   to a mktemp file and `cmp`s it with the tracked copy (same "out of date" error). Checked: an edit to
   styles-panels.css is reported as drift and the tracked styles.css stays untouched.
7. `mcp` in server/requirements.txt: already present (`mcp==2.3.0`, `mcp-types==2.3.0`, added in 8f25190).
   Note: the shared venv (veritas/server/.venv) has no `mcp` installed, so `server.py` (the MCP entry point)
   cannot start from it; not installed here (install is a gate).
8. zotero/package.json "type": "module": real gap found and fixed in 12c1029. Zotero loads bootstrap.js and
   content/*.js with loadSubScript (classic scripts), but `node --check` parsed them as modules, so a stray
   `export` passed the check (shown with a temp copy). check.sh now parses each file with `vm.Script`; all 14
   tracked files plus the built agent.js and sb-ui.js (iife) parse. `node -p 'require(...)'` in check.sh is
   unaffected (eval input is CommonJS). The .mjs build scripts are unaffected.

./check.sh: all parts passed. tools 15, agent 809, ui 290, web 62, obsidian 27, zotero 12,
server 351 passed / 3 skipped.

## Merge order
TG4 → TG1 → TG3 → TG2 (TG2 is largest and depends on TG1's platform code for the Windows/Linux builds).
