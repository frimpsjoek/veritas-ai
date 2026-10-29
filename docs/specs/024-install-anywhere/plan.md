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

### TG3 evidence (2026-10-28, branch `ai/024-g4-updates`)

What exists now:
- `.github/workflows/release.yml` (tag `v*`): `node tools/release.mjs verify <v>` (every part says the tag's version),
  `./check.sh`, then the GitHub Release with `veritas-zotero-<v>.xpi`, `update.json` and `veritas-obsidian-<v>.zip`
  (notes = the CHANGELOG section + install/update lines); job `tap` computes the tag tarball's sha256 and commits
  `node tools/release.mjs formula <v> <sha256>` as `Formula/veritas.rb` to `frimpsjoek/homebrew-veritas` with
  `HOMEBREW_TAP_TOKEN`.
- `tools/release.mjs <v> [--dry-run]`, `verify`, `notes`, `formula`; `tools/release.test.mjs`; `CHANGELOG.md` (0.53.0,
  0.54.0 from the release notes); formula header + caveat; `docs/guide/updating.md`; README "Updating"; docs/README row.

Checks run:
- `node --test tools/*.test.mjs`: 27 tests, 27 pass (14 boundaries + 13 release: JSON/lock rewriting, formula url,
  sha256 and revision, CHANGELOG insert and notes, optional `tauri.conf.json` and `obsidian/versions.json`, verify,
  and the real script in a temp git repo: --dry-run writes nothing, a release commits + tags + prints the push, refuses
  a dirty tree, an older version and an existing tag).
- `./check.sh` in this worktree before the changes: all parts passed (server 350 passed, 3 skipped).
- `node tools/release.mjs 0.55.0 --dry-run` in this worktree: exit 0, 15 files would change (package.json +
  package-lock.json of agent, ui, web, obsidian, zotero; both manifests; formula url v0.54.0 → v0.55.0 and `revision 2`
  dropped; README plugin links 0.53.0 → 0.55.0; CHANGELOG `## 0.55.0 (2026-10-28)` with the commit subjects since
  v0.54.0); `git status` clean and no tag afterwards. No `tauri.conf.json` or `versions.json` yet, so skipped.
- Real run on a scratch clone (`git clone` into the scratchpad, branch `scratch/release-0.55.0`, no remote, so the
  shared repo got no tag): commit "Release 0.55.0" (15 files, +30 −9), tag v0.55.0, printed
  `git push origin scratch/release-0.55.0 v0.55.0`; `verify 0.55.0` ok; `./check.sh` on the bumped clone:
  all parts passed (tools 27, agent 808, ui 290, web 62, obsidian 27, zotero 12, server 350 passed + 3 skipped);
  its `zotero/dist/update.json` says 0.55.0 and links `releases/download/v0.55.0/veritas-zotero-0.55.0.xpi`, and the
  bumped package-lock files pass `npm ci`.
- The release-files step run locally (v0.53.0 build): xpi, update.json, Obsidian zip with `veritas/{main.js,
  manifest.json,styles.css}` (same layout as the v0.54.0 asset), notes.md.
- `curl …/archive/refs/tags/v0.54.0.tar.gz | shasum -a 256` = the sha256 in the formula and the tap (b4d5518e…), so the
  workflow's way of computing it matches what Homebrew checks.
- Zotero: `manifest.json` `update_url` = `releases/latest/download/update.json`; `build.sh` writes `update_link` =
  `releases/download/v<v>/veritas-zotero-<v>.xpi` from the manifest version. The workflow uploads exactly that name,
  marks the release `--latest` and greps update.json for the link. Found: v0.54.0's update.json points at the v0.53.0
  release (manifest was left at 0.53.0); lockstep versions + `verify` stop that drift.
- brew upgrade path, from the formula and Homebrew 4.6.10's source (no brew run): `brew upgrade` runs `post_install`
  for the new keg (`formula_installer.rb` finish), with network allowed for third-party taps
  (`DEFAULT_NETWORK_ACCESS_ALLOWED = true`); `post_install` reuses `var/veritas/venv` (`uv venv --allow-existing`,
  then `uv pip install -r` the new requirements) and reinstalls the web app into `var/veritas/web` by rename;
  `var/veritas` is outside the keg, so data stays. `upgrade.rb` does not restart services (Homebrew's own caveat says
  "To restart … after an upgrade: brew services restart"), and it cleans the old keg, which the running server's cwd
  and agentd still use, so the formula caveat and the guide now say `brew services restart veritas`.

Cannot be checked before a push and tag (user gates):
- release.yml itself (no actionlint/shellcheck on this Mac; YAML parsed, steps simulated locally): it first runs on the
  next pushed tag. The tap job needs the secret. A tag whose versions were not bumped fails at `verify`.
- `brew upgrade veritas` live from 0.54.0_2 to the next version. Check then: `brew upgrade veritas` prints the new
  caveat; `ls $(brew --prefix)/var/veritas` keeps data/, models/, venv/; `var/veritas/web/index.html` is new;
  `brew services restart veritas` → `veritas status` answers; a Python patch upgrade followed by
  `brew postinstall veritas` still starts.
- Zotero updating in place from 0.53.0 to the next release through `update.json` (needs a published release).

One-time steps for the user:
1. Fine-grained personal access token: only `frimpsjoek/homebrew-veritas`, Contents read and write; set an expiry.
2. In `frimpsjoek/veritas-ai` Settings > Secrets and variables > Actions: secret `HOMEBREW_TAP_TOKEN` = that token.
3. To release: `node tools/release.mjs <v> --dry-run`, `node tools/release.mjs <v>`, then the printed
   `git push origin main v<v>`.

Coordination with TG2: `release-app.yml` should add its installers to the same tag's release (`gh release upload`); this
workflow adds its files if that release already exists. `tools/release.mjs` bumps `app/src-tauri/tauri.conf.json` when
present (tested with a fixture).

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

## TG5: Windows process fixes left open by TG1 (branch `ai/024-windows-spawn`)
1. CLI shims: on Windows `spawn()` resolves `.cmd`/`.bat` (and bare names found through PATH, such as `npx`) before
   starting them (`agent/src/node/windows-command.mjs`): npm's shim → `node <script>` (node.exe beside the shim, else
   node on PATH); else an `.exe` beside it; else cmd.exe only when every argument is plain (`[A-Za-z0-9_\-.,:/\\=@+]`);
   else a child that exits 127 with the reason. macOS/Linux take the old line unchanged.
2. Stop indexing: the server writes `index-stop` in the data folder; `Progress.advance` checks it between batches on
   every system; SIGTERM stays the fast path off Windows (where `os.kill` would be TerminateProcess). A new or
   stopped run removes the file.
3. Self-update: `replace_self()`; `os.execv` on macOS/Linux; on Windows close the listener, start the new server
   detached (`DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP`), `os._exit(0)`.
- Each: failing test first, smallest change, one commit; `./check.sh` at the end.

### TG5 evidence (2026-10-28, macOS 26 arm64, Node 22, Python 3.12 venv)
- Before (at `2c19ef3`): agent 817, server 370 passed + 3 skipped.
- 7dd5beb shims: agent 817 → 823. Fixture shims on a mocked win32: cmd-shim's exact format (script after
  `%dp0%`, node.exe beside it preferred), Node's `npx.cmd` (script in a variable set twice, bare `npx` via PATH),
  a non-npm shim with an `.exe` neighbour, an unknown `.bat` (plain args → `shell: true` with the path quoted;
  spaces, `&`, `%VAR%`, `|`, quotes, `^`, empty → refused), `.exe` and missing commands passed through, and a real
  spawn through the mocked-win32 platform (npm shim → node runs the script with `a & b` intact; refused → 127 + reason).
- 524ae30 stop: server 370 → 374 (stop file written on darwin/linux/win32, SIGTERM only off Windows; a stale file
  cleared, a new one stops the run at the next batch).
- 56c7bba self-update: server 374 → 377 (darwin/linux execv; win32 close → detached start → exit, in that order).
- `./check.sh` after: all parts passed; tools 31 (30 + 1 skipped), agent 823, ui 291, web 62, obsidian 27,
  zotero 12, server 377 passed + 3 skipped.
- Not checked here: a real Windows machine (none available). Still open: the detached server on Windows writes to
  whatever stdout/stderr it inherits (none when started from a console that then closes); under the desktop app
  (TG2) a self-replacing server leaves Tauri's supervision, so the app should restart its sidecar rather than rely
  on this path. The agentd entry spawn (TG2) was not touched.

## Merge order
TG4 → TG1 → TG3 → TG2 (TG2 is largest and depends on TG1's platform code for the Windows/Linux builds).
