# Spec 033: Veritas updates itself from GitHub releases

Status: APPROVED 2026-11-19 (user: "Approve, build it"; D1 drop the Intel Mac build; D2 review before the first push; D3 install when not in use).

Written from the user's request of 2026-11-19: "can we get it such that its updated on its own with some CI CD or
something?", and their choice: "GitHub CI/CD releases" (over a pipeline on this Mac only).

## What exists, and why it has never updated this Mac (read from the repo and GitHub)

- `.github/workflows/release-app.yml` builds the app for macOS (Apple silicon, Intel), Windows and Linux on a `v*` tag
  and attaches the installers and `latest.json` (the signed update file) to the GitHub Release. The app checks
  `releases/latest/download/latest.json` once per start (`app/src-tauri/src/main.rs` `offer_update`).
- The last two app releases failed (v0.55.0, v0.55.1, 2026-11-12):
  - `TAURI_SIGNING_PRIVATE_KEY` is not set in the repo's secrets, so every signed build stops;
  - the Intel Mac job cannot install `onnxruntime==1.31.0` (no Intel macOS wheel).
- The newest working release is v0.54.0 (2026-10-23). This branch (`feat/027-browse`) is 187 commits ahead of
  `origin/main`, none of them pushed. The repository is public.
- A found update is only offered ("Install and restart" / "Later"); nothing installs by itself.
- The Zotero and Obsidian plugins update from this Mac's Veritas server (spec 006, fixed in eed0ae7), which only knows
  the builds made on this Mac.

## Goals

- R1. **Releases build again.** The updater's signing key (`app/.keys/veritas-updater.key`, on this Mac only) becomes
  the repo secret `TAURI_SIGNING_PRIVATE_KEY` (set by `gh secret set` from the file, never printed or committed). The
  Intel Mac build is handled as D1 decides.
- R2. **Every change on `main` is a release.** A push to `main` whose checks pass (check.yml) releases the next patch
  version on its own: the workflow stamps the version into the app and both plugin manifests (in the build, not as a
  commit), tags `v<version>`, builds every platform, and publishes the installers, `latest.json`, the Zotero xpi with
  its `update.json`, and the Obsidian build. A push with failing checks releases nothing.
- R3. **The app installs updates by itself.** It checks at start and every 6 hours; a new version is downloaded in the
  background and installed as D3 says, then the app restarts on its own and shows once "Veritas was updated to X". A
  setting "Install updates automatically" (on) turns it back into the offer of today. Signature checking stays.
- R4. **The plugins follow the app.** Each app build carries the Zotero xpi and the Obsidian build of the same version;
  the app's server offers them (a third place beside the repo and `<data dir>/plugins/`), so when the app updates, the
  Zotero and Obsidian plugins update themselves within minutes (this Mac's Zotero is already set to "server"; Obsidian's
  default is "server"). Installs without the app keep Zotero's GitHub `update_url`.
- R5. **This Mac switches to it.** After the first release from `main`, the app installed here is that release (not a
  local build), and later changes reach it through R2-R4. Local builds remain for trying a change before it is merged.
- R6. **Nothing private goes public by accident.** `key`, `key.pub`, `sig`, `allowed` (untracked files at the repo root)
  and `app/.keys/` are ignored by git; before the first push, the 187 commits are reviewed as D2 decides.

## Non-goals

- No Apple notarization or Windows code signing (unchanged, spec 024 D3); the in-app updater's own signature is the check.
- No change to what Veritas does, only to how it is shipped.

## Decisions for the user (recommendation first)

- D1. The Intel Mac build. **(a, recommended) Drop it** (onnxruntime ships no Intel macOS wheel since 1.20; Intel Macs
  can use the Homebrew install). (b) Keep it with an older onnxruntime pinned for Intel only (slower search, more upkeep).
- D2. What goes public with the first push. **(a, recommended) I list what the 187 commits add that is personal (paper
  titles from your library, people's names, paths, notes in specs and validation files), you decide per item, and I
  rewrite those parts before pushing.** (b) Push as they are.
- D3. When an update installs. **(a, recommended) When Veritas is not in use** (no window open or focused for 15
  minutes), else at the next quit. (b) At once, as soon as it is downloaded (a window open at that moment closes and
  reopens).

## Gates (each one asks you first)

- Setting the GitHub secret; every push to `main` (the first one publishes the 187 commits); the first release tag.

## Way of working

- The work before this spec is committed (eed0ae7). Commits: R6 (.gitignore), R1 (workflow fix), R2 (continuous
  release), R3 (silent install), R4 (plugins in the bundle); each with its tests (Rust unit tests for the install rule,
  workflow dry run with `act` or a test tag on a fork where possible). Evidence: a release built by GitHub from `main`,
  installed here by the app itself, and the plugins updated after it; recorded in `validation.md`.
