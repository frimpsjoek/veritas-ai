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
- Added 2026-10-28 (user, via the coordinator): before indexing anything, a first start offers to reuse an index this
  computer already has (Homebrew `var/veritas`, then the old Second Brain `obsidian-kb/data`, or a folder the user
  picks), copied read-only (`kb.py import-data`), instead of embedding the library again.

### TG2 evidence (2026-10-28, branch `ai/024-g3-desktop`)

**Built.**
- `packaging/pyinstaller/`: `veritas-server.spec` + `veritas_server.py` (entry = `kb.main()`; drops the `kb.py`
  argument the indexing subprocess passes, since frozen `sys.executable` is the binary) + `build.sh` (venv
  `.venv-build`, `uv`, copies to `app/src-tauri/binaries/veritas-server-<triple>`). Server modules as hidden imports and
  as data files (kb.py and http_api.py stat their own sources); mlx, onnx, pytest, mcp, pyobjc excluded.
- `packaging/sea/`: `build.mjs` bundles `agent/src/node/agentd.mjs` to CommonJS with esbuild (the `import.meta.url`
  main guard is defined true), `--experimental-sea-config`, postject, ad hoc codesign on macOS. No server change was
  needed: the app sets both `SECOND_BRAIN_NODE` and `SECOND_BRAIN_AGENTD_ENTRY` to the SEA binary; agentd ignores the
  extra positional argument.
- `app/` (Tauri 2.10, tauri-cli 2.12.4): start page `app/ui/index.html`; `src/main.rs` (boot command, tray menu Open /
  Start at login / Quit, close = hide, single instance, window state, updater asking "Install and restart" / "Later"),
  `server.rs` (port 27182 else free; server in its own process group; quit = SIGTERM to the group, SIGKILL after 5 s,
  then SIGTERM to a running `kb.py index` from index-progress.json), `model.rs` (3 files from huggingface.co with
  progress, `.part` + rename), `web.rs` (bundled `web/dist-web` into `<data>/web` once per app version, like
  `web/install.sh`). Icons from `docs/images/veritas-logo.png` (`cargo tauri icon`), tray icon = the V mark.
  `hardenedRuntime: false`: with it, ad hoc signing made dyld refuse the PyInstaller-unpacked libpython ("different
  Team IDs"); an unsigned app does not need it (it is for notarization).
- `server/import_data.py` + `kb.py import-data [--find|<folder>] [--replace]` + `tests/test_import_data.py` (5 tests).
- Updater keypair: `cargo tauri signer generate --ci -p "" -w app/.keys/veritas-updater.key` (git-ignored); public
  key in `tauri.conf.json`; endpoint `releases/latest/download/latest.json`.
- `.github/workflows/release-app.yml`, `docs/guide/install-desktop.md`, README link, `check.sh` app step (skips without
  cargo or sidecars).

**Commands and results (this Mac, arm64, macOS 26).**
- `curl https://sh.rustup.rs | sh -s -- -y --profile minimal` → rustc 1.99.1; `cargo install tauri-cli --version '^2'
  --locked` → 2.12.4.
- `packaging/pyinstaller/build.sh` → `veritas-server` 52 MB. Smoke: `VERITAS_DATA=<scratch> veritas-server serve
  --port 27999` → `/ping` ok, `/status` answers; with the SEA agent `/agent/skills` 200; SIGTERM → server and agentd gone.
- `node packaging/sea/build.mjs` → `agentd` 110 MB; `agentd agentd --port 0 --data <scratch>` prints its status line.
- `CI=true cargo tauri build` (with `TAURI_SIGNING_PRIVATE_KEY` from app/.keys) →
  `app/src-tauri/target/release/bundle/dmg/Veritas_0.54.0_aarch64.dmg`, 93,820,482 bytes (89.5 MiB), sha256
  `2797fc08cceb47040794fcf4c5b8d39e4c733a8792a12a1058ef0dad3d8f68e3`; `Veritas.app.tar.gz` + `.sig` for the updater.
  Without `CI=true` the dmg step scripts Finder on a temporary mounted image; twice it hung and left the image
  mounted, and an app was started from that image with the real home folder (stopped, its half-built data folder
  deleted). CI=true skips that step.
- App from the mounted .dmg, copied to a scratch home, `HOME=<scratch> Veritas.app/Contents/MacOS/veritas`:
  - empty data folder: the first start (an earlier build, before index reuse) downloaded the model (133 MB) and
    started the server; the current build stops at the offer: after 20 s only `web/` exists, no server, no indexing.
  - after `veritas-server import-data ~/Documents/second-brain-dev/obsidian-kb/data` (6.4 s; 440 MB copied: kb.sqlite,
    tantivy, sources.json, agent without codex-home, model): server up in ~12 s on a free port (27182 was held by the
    Homebrew server), `/app/` 200, `/status` 4,036 notes, 85,322 passages all with vectors, indexing "Up to date"
    (14 passages of changed notes added, nothing re-embedded), CPU 0%, `/agent/skills` 200, the web view connected.
  - Quit (Apple event) → app, server, agentd all gone within 1 s.
- SIGTERM to the server launcher while embedding 85k passages at 370% CPU → all its processes gone within the
  check. The run that "ignored SIGTERM" was in state U: its executable lived on a disk image that had been force-
  detached under it. The process-group stop covers the one-file launcher's Python child either way.
- `./check.sh` → all parts passed (server 355 passed, 3 skipped; app cargo check). `node tools/boundaries.mjs .` → ok.

**Not checked, and why.**
- Windows and Linux builds, the Intel .dmg and latest.json: only on CI runners (release-app.yml), which run on a tag
  push (user gate). The Windows server needs TG1 first (kb.py imports `fcntl`).
- The update itself (one release to the next): needs two tagged releases.
- The start page's look, the tray menu and "Start at login" by hand: no screen access from this session
  (`screencapture` refused); the offer, download and start paths were checked by their effects on disk and ports.
- Guided setup and a chat answer with citations in the app window: for the user, after installing the .dmg (gate).

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
