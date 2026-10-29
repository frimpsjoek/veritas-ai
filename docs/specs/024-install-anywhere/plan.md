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

### TG1 evidence (2026-10-28, branch `ai/024-g2-platforms`, macOS 26 arm64, Node 22, Python 3.12 venv)
- `./check.sh` before (at `4fdcd01`): all parts passed; tools 15, agent 808, ui 290, web 62, obsidian 27, zotero 12,
  server 357 passed + 3 skipped.
- `./check.sh` after (at `044c0eb`): all parts passed; tools 19 (18 pass + 1 skipped: the `veritas.cmd` run is
  Windows-only), agent 816, ui 291, web 62, obsidian 27, zotero 12, server 369 passed + 3 skipped.
- New tests: Zotero profile folders per system (4 cases + Linux prefs found), `zotero_files` prefs at call time and the
  Python PDF walk; OCR engine per system, Tesseract through stdin, no engine = text-layer PDFs only, `/status` `ocr`;
  agent keys on Linux (secret-tool), Windows (PowerShell, script decoded and checked to hold no key), both fallbacks
  and the error path; server Zotero keys the same three ways plus the owner-only file (0600 checked on POSIX);
  `which()` with PATHEXT; index lock exclusive; indexing spawns without `taskpolicy` off macOS; `veritas.cmd` parity
  with `bin/veritas` and CRLF endings.
- Real Tesseract smoke test: `test_real_tesseract_reads_a_rendered_page` passed with `/opt/homebrew/bin/tesseract`
  (reads "solar" from a rendered PNG). The xpi built through the Python `zipfile` fallback has the same 70 entries as
  the `zip` one.
- Not checked here: Windows and Linux themselves. Only macOS was available; the `check.yml` matrix (ubuntu, macos,
  windows; Git Bash, `core.autocrlf false`, `PYTHONUTF8=1`) runs first on a push, which is the user's gate. The
  Windows code paths (Credential Manager script, `msvcrt` lock, `veritas.cmd`, PATHEXT) are covered only by mocked
  tests until then, and the spec's "Windows run with a real Zotero library" is still to do.
- Left open (written down, not fixed here):
  - Node refuses to spawn `.cmd`/`.bat` files without a shell (CVE-2024-27980), so on Windows the npm shims
    `claude.cmd`, `codex.cmd` and `npx.cmd` that `which()` now finds will fail with EINVAL; a fix needs `shell: true`
    with cmd.exe quoting of prompt arguments, or resolving the shim to its `node <script>` (a decision for TG2/G3).
  - Windows: "Stop" indexing is `os.kill(SIGTERM)` = TerminateProcess (no finishing the batch); the self-update
    `os.execv` starts a new process instead of replacing this one.
  - The server needs UTF-8 mode on Windows: `veritas.cmd` and CI set `PYTHONUTF8=1`; the PyInstaller sidecar (TG2)
    must set it too (`-X utf8`).
  - `secret-tool store` may keep the trailing newline the agent writes on stdin; both readers strip it.
  - Images read while no OCR engine was installed are cached as empty: after installing Tesseract, restart Veritas and
    re-read images (the Settings line says so).
- Installs for the user to approve: none needed for this group. Optional on Windows/Linux machines: Tesseract
  (`winget install UB-Mannheim.TesseractOCR`, `apt install tesseract-ocr`) for scans and images; `libsecret-tools`
  on Linux for `secret-tool`.

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
- [ ] Done when every item has a commit or a written reason to leave it.

## Merge order
TG4 → TG1 → TG3 → TG2 (TG2 is largest and depends on TG1's platform code for the Windows/Linux builds).
