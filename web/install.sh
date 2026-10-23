#!/bin/sh
# Builds the web app (ui-src: npm run build:web) and installs it into the Second Brain server's data/web/, which the
# server serves at /app/. Run it with every release (obsidian-plugin/install.sh calls it); the next page load shows
# the new version.
#
# Every file goes in by rename, so a request never sees a half-written one, and the server's own files
# (state.json, sessions.json, pending-adds.json) are never touched. The hashed scripts and styles go in first and
# index.html and login.html last, so the page that names them never arrives before them; hashed files of older
# builds are removed after.
#   KB=/path/to/server    the server folder (default: ../server in this repo)
set -e
cd "$(dirname "$0")"
KB="${KB:-$(cd ../server && pwd)}"
dest="${VERITAS_DATA:-$KB/data}/web"  # VERITAS_DATA: the data folder outside the code (server/paths.py)
npm run --silent build
src="dist-web"
[ -f "$src/index.html" ] || { echo "install-web: $src/index.html missing after the build" >&2; exit 1; }
mkdir -p "$dest"
put() { cp "$src/$1" "$dest/.$1.new" && mv -f "$dest/.$1.new" "$dest/$1"; }
for f in "$src"/*; do
  name="$(basename "$f")"
  case "$name" in index.html|login.html) ;; *) put "$name" ;; esac
done
put login.html
put index.html
# old builds' hashed files: anything app-/login-/pdf-<8 hex> that this build does not ship
for old in "$dest"/app-*.js "$dest"/app-*.css "$dest"/login-*.js "$dest"/pdf-*.mjs; do
  [ -e "$old" ] || continue
  [ -e "$src/$(basename "$old")" ] || rm -f "$old"
done
echo "web app installed to $dest ($(ls "$src" | wc -l | tr -d ' ') files)"
