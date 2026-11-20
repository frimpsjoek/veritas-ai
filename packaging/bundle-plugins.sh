#!/bin/sh
# Spec 033 R4: puts this version's Zotero xpi and Obsidian build into app/src-tauri/plugins/ (bundled as a resource), so
# a released app carries the plugins of its own version and its server offers them for self-update. Run after
# zotero/build.sh and the Obsidian build; release-app.yml does this for every release.
set -e
cd "$(dirname "$0")/.."
version=$(node -p 'require("./zotero/manifest.json").version')
out=app/src-tauri/plugins
rm -rf "$out"
mkdir -p "$out/zotero" "$out/obsidian/$version"
cp "zotero/dist/second-brain-$version.xpi" "$out/zotero/"
cp obsidian/main.js obsidian/manifest.json obsidian/styles.css "$out/obsidian/$version/"
echo "bundled plugins $version into $out"
