#!/bin/sh
# Builds the plugin, copies it into the vault, and publishes a versioned copy that the Second Brain server reads
# for plugin auto-update (spec 006): building is publishing, no separate step.
set -e
cd "$(dirname "$0")"
npx tsc -p .
node esbuild.config.mjs
dest="$HOME/Documents/Second-Brain/.obsidian/plugins/second-brain-search"
mkdir -p "$dest"
cp main.js manifest.json styles.css "$dest/"
echo "installed to $dest"
version=$(node -p 'require("./manifest.json").version')
published="dist-versions/$version"
mkdir -p "$published"
cp main.js manifest.json styles.css "$published/"
echo "published to $published"
# The web app (spec 013) ships with every release: build it and swap it into the server's data/web.
../zotero-plugin/install-web.sh
