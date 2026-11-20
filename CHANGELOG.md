# Changelog

Each release of Veritas AI. `node tools/release.mjs <version>` adds the next section (the commit subjects since the
last tag, to edit before pushing); the GitHub Release shows that section as its notes.

## 0.54.3 (2026-11-20)

- Obsidian install.sh: install into the vault Obsidian has open, not a fixed folder

## 0.54.2 (2026-11-20)

- Obsidian: an open note no longer blocks the plugin's self-update forever

## 0.54.1 (2026-11-20)

- Check: Windows runs but does not block a release yet; two Windows test mistakes fixed
- Tests: run macOS-only tests on macOS only (MLX models, Keychain, /bin/sh)
- Veritas: Browse, Read later, chained workflows, full-text papers, self-updating releases
- Homebrew: install steps in README and guide; formula revision 2 (Python env and uv cache in var/veritas)

## 0.54.0 (2026-10-23)

- Install with Homebrew on macOS and Linux: `brew install frimpsjoek/veritas/veritas`, `brew services start veritas`.
- Data and the search model kept outside the code folder (`VERITAS_DATA`), and the `veritas` command (serve, open,
  status, model).
- Guided setup on Home: finds Zotero, Obsidian vaults and PDF folders; each step done in place.
- Abstracts from OpenAlex for Zotero items that have none; figures for journal papers through their arXiv preprints.
- Keys saved to an owner-only file when no Keychain is usable.
- The Zotero and Obsidian plugins are the same as in 0.53.0.

## 0.53.0 (2026-10-22)

- First public release (OSI Hackathon 2026): the Veritas server, web app, and the Zotero and Obsidian plugins named
  Veritas, which update from veritas-ai releases.
- Documentation: getting started, reading radar, chat, connectors and MCP, plugins, privacy, architecture.
