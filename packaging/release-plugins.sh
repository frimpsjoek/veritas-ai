#!/bin/sh
# One step after any change to the Zotero or Obsidian plugin (or the shared ui/ they bundle): raise the lockstep version
# (patch, or the part given: patch | minor), build both, and publish them to this Mac's desktop app server, from which
# both plugins update themselves (Zotero every 15 minutes, Obsidian on its own check), without anyone clicking.
set -e
cd "$(dirname "$0")/.."
part="${1:-patch}"
next=$(node -e '
  const v = require("./zotero/manifest.json").version.split(".").map(Number);
  if (process.argv[1] === "minor") { v[1] += 1; v[2] = 0; } else v[2] += 1;
  console.log(v.join("."));' "$part")
for f in zotero/manifest.json obsidian/manifest.json; do
  node -e 'const fs=require("fs");const f=process.argv[1];const j=JSON.parse(fs.readFileSync(f,"utf8"));j.version=process.argv[2];fs.writeFileSync(f,JSON.stringify(j,null,2)+"\n")' "$f" "$next"
done
(cd zotero && sh build.sh)
sh obsidian/install.sh
echo "released plugins $next"
