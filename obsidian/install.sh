#!/bin/sh
# Builds the plugin, copies it into the vault, and publishes a versioned copy that the Second Brain server reads
# for plugin auto-update (spec 006): building is publishing, no separate step.
set -e
cd "$(dirname "$0")"
npx tsc -p .
node esbuild.config.mjs
# The vault Obsidian has open (its own vault list), or $OBSIDIAN_VAULT; none found: build and publish only. A hard-coded
# folder here once pointed at a vault Obsidian no longer opened, so the plugin never reached the real one.
vault="${OBSIDIAN_VAULT:-$(node -e '
  const os = require("os"), fs = require("fs"), path = require("path");
  const dirs = { darwin: "Library/Application Support/obsidian", win32: "AppData/Roaming/obsidian" };
  const file = path.join(os.homedir(), dirs[process.platform] ?? ".config/obsidian", "obsidian.json");
  try { const v = Object.values(JSON.parse(fs.readFileSync(file, "utf8")).vaults ?? {}); console.log((v.find((x) => x.open) ?? v[0])?.path ?? ""); } catch { console.log(""); }')}"
if [ -n "$vault" ] && [ -d "$vault/.obsidian" ]; then
  dest="$vault/.obsidian/plugins/second-brain-search"
  mkdir -p "$dest"
  cp main.js manifest.json styles.css "$dest/"
  echo "installed to $dest"
else
  echo "no Obsidian vault found: built and published only (set OBSIDIAN_VAULT to install)"
fi
version=$(node -p 'require("./manifest.json").version')
published="dist-versions/$version"
mkdir -p "$published"
cp main.js manifest.json styles.css "$published/"
echo "published to $published"
sh ../packaging/publish-plugins.sh || true
# The web app (spec 013) ships with every release: build it and swap it into the server's data/web.
KB="$(cd ../server && pwd)" ../web/install.sh
