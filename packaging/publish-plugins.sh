#!/bin/sh
# Publishes the newest plugin builds to the desktop app's server, so the Zotero and Obsidian plugins update themselves
# (spec 006 lockstep; the installed app has no repo beside it). Copies zotero/dist/second-brain-<v>.xpi and
# obsidian/dist-versions/<v>/ into <data dir>/plugins/. The data dir is $VERITAS_DATA, else the app's own on macOS;
# nothing happens when that folder does not exist (no desktop app on this machine).
set -e
cd "$(dirname "$0")/.."
data="${VERITAS_DATA:-$HOME/Library/Application Support/io.github.frimpsjoek.veritas}"
[ -d "$data" ] || exit 0
mkdir -p "$data/plugins/zotero" "$data/plugins/obsidian"
version=$(node -p 'require("./zotero/manifest.json").version')
[ -f "zotero/dist/second-brain-$version.xpi" ] && cp "zotero/dist/second-brain-$version.xpi" "$data/plugins/zotero/"
[ -d "obsidian/dist-versions/$version" ] && rm -rf "$data/plugins/obsidian/$version" && cp -R "obsidian/dist-versions/$version" "$data/plugins/obsidian/$version"
echo "plugins $version published to $data/plugins"
