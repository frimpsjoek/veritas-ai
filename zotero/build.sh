#!/bin/sh
# Builds dist/second-brain-<version>.xpi and dist/update.json (the file Zotero checks for updates).
set -e
cd "$(dirname "$0")"
(cd editor-src && npm ci --silent && npm run build --silent)
(cd ../agent && npm ci --silent && npm run build --silent)  # the server's agentd
(cd ../ui && npm ci --silent)
npm ci --silent
node build-agent.mjs  # content/agent.js from ../agent
node build-ui.mjs     # content/sb-ui.js, sb-ui.css, home/ from ../ui
# The Obsidian plugin compiles agent and ui with noImplicitAny; agent's own tsconfig does not. Check it here so a
# release never builds the xpi from code Obsidian's install.sh then refuses (0.47.0 did).
(cd ../obsidian && npm ci --silent && npx tsc -p .)
version=$(node -p 'require("./manifest.json").version')
mkdir -p dist
rm -f "dist/second-brain-$version.xpi"
zip -qr "dist/second-brain-$version.xpi" manifest.json bootstrap.js content locale -x '*.DS_Store'
hash=$(shasum -a 256 "dist/second-brain-$version.xpi" | cut -d' ' -f1)
cat > dist/update.json <<JSON
{
  "addons": {
    "second-brain@frimpsjoe.local": {
      "updates": [{
        "version": "$version",
        "update_link": "https://github.com/frimpsjoek/zotero-second-brain/releases/download/v$version/second-brain-$version.xpi",
        "update_hash": "sha256:$hash",
        "applications": { "zotero": { "strict_min_version": "7.0", "strict_max_version": "10.*" } }
      }]
    }
  }
}
JSON
echo "dist/second-brain-$version.xpi"
