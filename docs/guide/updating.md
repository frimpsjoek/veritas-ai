# Updating

Every part of Veritas has the same version number, and each release is a tag `v<version>` on GitHub with its files on
the [releases page](https://github.com/frimpsjoek/veritas-ai/releases). Your data (notes, index, settings, keys and the
search model) is never part of an update.

## Homebrew (macOS and Linux)

```sh
brew update                       # fetches the new formula from the tap
brew upgrade veritas
brew services restart veritas     # Homebrew does not restart a running service itself
```

The upgrade installs the new code in a new folder, then refreshes the Python packages and the web app in
`$(brew --prefix)/var/veritas`, where your data also lives; nothing there is removed. Restart the service so it runs the
new code: Homebrew deletes the old version's folder after the upgrade, and the running server still uses it.

If Veritas stops starting after Homebrew upgrades Python, rebuild its Python environment:

```sh
brew postinstall veritas && brew services restart veritas
```

## Desktop app

The desktop app (macOS, Windows, Linux) checks GitHub Releases when it starts. When there is a newer version it asks
before installing; your data stays in the app's data folder.

## Zotero plugin

Zotero checks for plugin updates by itself (about once a day) against the latest release's `update.json`, and installs
the new `veritas-zotero-<version>.xpi`. To check now: **Tools > Plugins**, the gear menu, **Check for Updates**.

## Obsidian plugin

Obsidian has no updater for plugins outside its community list. Download `veritas-obsidian-<version>.zip` from the
[latest release](https://github.com/frimpsjoek/veritas-ai/releases/latest), unzip it into
`<your vault>/.obsidian/plugins/` over the old `veritas` folder, and reload Obsidian. Your plugin settings are kept.

With a source install, the plugin also updates from your own Veritas server: it checks at start and every 15 minutes
(or **Settings > About > Check for updates**), and a new version is offered once `zotero/build.sh` and
`obsidian/install.sh` have both built it. A Homebrew server has no plugin builds to offer, so use the zip.

## Source install (git)

```sh
cd veritas-ai && git pull
(cd server && uv pip install --python .venv/bin/python -r requirements.txt)
(cd agent && npm ci && npm run build)
(cd web && npm ci && ./install.sh)
```

Then restart the server (`cd server && KB_BACKEND=onnx .venv/bin/python kb.py serve`). To move to one release rather
than the newest commit: `git checkout v<version>` instead of `git pull`.

## Cutting a release (maintainers)

```sh
node tools/release.mjs 0.55.0 --dry-run   # prints the diff: every version file, README links, CHANGELOG.md
node tools/release.mjs 0.55.0             # writes it, commits "Release 0.55.0", tags v0.55.0; never pushes
git push origin main v0.55.0              # the command it prints
```

Pushing the tag runs `.github/workflows/release.yml`: `./check.sh`, then the GitHub Release with the Zotero `.xpi`,
`update.json` and the Obsidian `.zip`, then a commit to the tap `frimpsjoek/homebrew-veritas` with the tag's tarball
url and sha256 (from `packaging/homebrew/veritas.rb`, revision back to 0).

One-time setup, so the workflow can commit to the tap:

1. GitHub > Settings > Developer settings > Personal access tokens > **Fine-grained tokens** > Generate new token.
   Repository access: **Only select repositories**, `frimpsjoek/homebrew-veritas`. Permissions: **Contents: Read and
   write** (Metadata: Read is added by itself). Pick an expiry and note it.
2. In `frimpsjoek/veritas-ai`: Settings > Secrets and variables > Actions > **New repository secret**, name
   `HOMEBREW_TAP_TOKEN`, value the token.

Without the secret the tap job stops with a message naming it; with an expired token the tap checkout fails. Either
way the GitHub Release is already made: add or replace the secret, then re-run the failed `tap` job from the Actions
page.
