#!/bin/sh
# Tests and checks every part of Veritas, the same way locally and in CI. Stops at the first failure.
#   ./check.sh                  everything
#   VERITAS_BROWSER=1 ./check.sh  also the Playwright screenshot harness (ui/dev/run.mjs; needs `npx playwright install`)
set -e
cd "$(dirname "$0")"
step() { printf '\n== %s\n' "$1"; }

step "tools: boundary check tests + repo scan"
node --test tools/*.test.mjs
node tools/boundaries.mjs .

step "agent: tests + typecheck"
(cd agent && npm ci --silent && npm test && npm run typecheck)

step "ui: tests + typecheck"
(cd ui && npm ci --silent && node --test test/*.test.js && npm run typecheck)

step "web: tests + typecheck + build"
(cd web && npm ci --silent && npm test && npm run typecheck && npm run build)

if [ -n "$VERITAS_BROWSER" ]; then
  step "ui: browser harness"
  (cd ui && node dev/run.mjs)
fi

step "obsidian: typecheck + tests + build"
# styles.css is generated from ui's CSS but committed (Obsidian loads it as is): build it to a temp file and
# compare, so the check never rewrites the tracked copy.
styles=$(mktemp)
(cd obsidian && npm ci --silent && npx tsc -p . && npm test && STYLES_OUT="$styles" node esbuild.config.mjs)
if ! cmp -s "$styles" obsidian/styles.css; then
  rm -f "$styles"
  echo "check.sh: obsidian/styles.css is out of date; rebuild it (cd obsidian && node esbuild.config.mjs) and commit it" >&2
  exit 1
fi
rm -f "$styles"

step "zotero: build + tests + package checks"
(cd zotero && ./build.sh && node --test test/*.test.mjs)
# Zotero loads these with loadSubScript, as classic scripts; `node --check` would parse them as modules
# (package.json "type": "module") and let a stray import/export through.
(cd zotero && for f in bootstrap.js content/*.js; do
  node -e 'new (require("vm").Script)(require("fs").readFileSync(process.argv[1], "utf8"), { filename: process.argv[1] })' "$f"
done)
python3 -c "import xml.dom.minidom as m; m.parse('zotero/content/preferences.xhtml')"
(cd zotero && version=$(node -p 'require("./manifest.json").version') && node -e 'const u = require("./dist/update.json"); const v = Object.values(u.addons)[0].updates[0].version; if (v !== process.argv[1]) { console.error(`update.json says ${v}`); process.exit(1); }' "$version")

step "server: tests"
if [ -x server/.venv/bin/python ]; then PY="$PWD/server/.venv/bin/python"; else PY=python3; fi
if "$PY" -c "import pytest" 2>/dev/null; then
  (cd server && KB_BACKEND=onnx "$PY" -m pytest tests -q -p no:cacheprovider)
else
  echo "check.sh: pytest not available (create server/.venv from server/requirements.txt); server tests skipped" >&2
fi

printf '\ncheck.sh: all parts passed\n'
