# Spec: install Veritas anywhere (Homebrew, then a desktop app for macOS, Windows and Linux)

Status: D1 and D2 decided 2026-10-22 (user: "D1 and D2"): Homebrew first, then a Tauri desktop app. D3-D5 pending.
Written from the user's requests of 2026-10-22: "can we turn into an application people can simply install" and
"2 [Homebrew] and can we make it a simple app any one can install on windows mac or linux".

Extends the Veritas roadmap's Phase 3b (desktop app: Tauri shell, Python server and agent as sidecars).

## Where we are

Installing today takes a terminal, Python 3.12 with uv, Node 22, a 133 MB model download and four build commands
(README, Install), and only macOS is tested. Parts that are macOS-only (checked in code 2026-10-22):

| Part | macOS | Elsewhere today |
|---|---|---|
| Keys | Keychain | owner-only file (`agent/src/secrets.js`, fallback added 653a15d) |
| OCR of images and scanned PDFs | Apple Vision (`server/media.py`) | none |
| Zotero profile (custom data folder, linked files) | `~/Library/Application Support/Zotero` (`server/sources.py`, `pdf_route.py`) | not found |
| Local models | MLX (Apple silicon) | Ollama / LM Studio already work |
| Start at login | LaunchAgent (hand-made) | none |
| Install scripts | `sh` | Windows needs another way |

## Goals

### G1. Homebrew (macOS and Linux), first

`brew install frimpsjoek/veritas/veritas` from a tap repository (`frimpsjoek/homebrew-veritas`):

- installs the server with its Python packages, the built agent and web app, and the search model;
- `brew services start veritas` runs it at login (launchd on macOS, systemd on Linux);
- `veritas open` opens the web app; `veritas status`, `veritas stop`.
- The formula builds from a tagged release of `veritas-ai`; a new tag updates the tap.

### G2. Runs on Windows and Linux, not only macOS

- Zotero's profile folder per system (Windows `%APPDATA%\Zotero\Zotero\Profiles`, Linux `~/.zotero/zotero`).
- OCR: Apple Vision on macOS; elsewhere Tesseract when installed, else PDFs with a text layer only (said in
  Settings > On this Mac, renamed "On this computer").
- Keys: macOS Keychain, Windows Credential Manager, Linux Secret Service; the owner-only file when none is usable.
- Paths, `~`, line endings and process spawning checked on all three; `./check.sh` runs in CI on all three.

### G3. A desktop app: download, double-click

`Veritas.dmg` (macOS), `Veritas-Setup.exe` (Windows), `Veritas.AppImage` / `.deb` (Linux), from GitHub Releases:

- A Tauri shell (Rust, small) opens the web app in its own window, with the Veritas icon, a menu-bar / tray icon
  and "start at login".
- Inside: the Python server built into one executable per system (PyInstaller), the Node agent as a single
  executable (Node SEA), and the search model downloaded on first start (133 MB, with progress) so the download
  stays small.
- First start shows the guided setup (spec 023); nothing else to configure.
- Updates: the app checks GitHub Releases (Tauri updater) and asks before installing.
- Built by GitHub Actions on macOS, Windows and Linux runners for each tag.

### G1 plan (Homebrew)

1. **Data outside the code folder.** The server keeps `data/` and `models/` inside its own folder (`kb.HOME`, 19
   places); Homebrew replaces that folder on every upgrade. A `VERITAS_DATA` setting (default: today's place, so
   nothing moves for existing installs) puts them elsewhere; the formula points it at
   `$(brew --prefix)/var/veritas`.
2. **A `veritas` command:** `veritas serve`, `veritas open`, `veritas status`; it downloads the search model on
   first start.
3. **The formula** in a tap repository `frimpsjoek/homebrew-veritas` (new public repository: needs the user's OK),
   building from a release tag of `veritas-ai` (a new tag, since v0.53.0 predates this work: needs the user's OK).
4. **Live check** on this Mac (installs into Homebrew: needs the user's OK) and on Ubuntu in CI.

## Success checks

- G1: on a clean macOS and a clean Ubuntu (CI and one real Mac): `brew install`, `brew services start`, the web app
  answers, a folder indexes, `brew uninstall` leaves nothing running.
- G2: `./check.sh` green on macOS, Windows and Ubuntu runners; unit tests for the Zotero profile paths and the key
  stores per system; a Windows run with a real Zotero library.
- G3: each installer installed on a clean VM of its system: app opens, guided setup completes, chat answers with
  citations, the app updates from one release to the next. Size of each installer recorded here.

## Decisions for the user (recommended first)

- D1. **Order:** Homebrew first (days), then the desktop app (weeks) (recommended); or go straight to the app.
- D2. **Desktop shell:** Tauri (small installers, ~10 MB plus the server; uses the system web view) (recommended),
  or Electron (bigger, ~150 MB, one Chrome everywhere).
- D3. **Code signing:** Apple Developer ID ($99/year) and a Windows code-signing certificate (~$100-300/year) so
  installs open without "unidentified developer" warnings (recommended before sharing widely); or unsigned at
  first, with install notes.
- D4. **Search model:** downloaded on first start (recommended, small installer) or inside the installer (+133 MB).
- D5. **Who builds it:** this session (G1, G2) and the Phase 3b owner session (G3), or one session for all.

## Non-goals

- App stores (Mac App Store, Microsoft Store) for now.
- Mobile apps (the phone keeps using the web app over Tailscale).
