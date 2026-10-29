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
- [ ] Done when every item has a commit or a written reason to leave it.

## Merge order
TG4 → TG1 → TG3 → TG2 (TG2 is largest and depends on TG1's platform code for the Windows/Linux builds).
