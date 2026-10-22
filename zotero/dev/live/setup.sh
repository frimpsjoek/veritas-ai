#!/bin/bash
# A throwaway headless Zotero over a copy of ~/Zotero, with this build and a runner that executes dev/live/*.js.
# Usage: dev/live/setup.sh [dir]; then dev/live/restart.sh; then dev/live/run.sh dev/live/sidebar.js
set -e
D=${1:-${SB_LIVE_DIR:-$HOME/.cache/sb-live}}; mkdir -p "$D/data" "$D/profile/extensions" "$D/q"
cp ~/Zotero/zotero.sqlite "$D/data/"; [ -f ~/Zotero/zotero.sqlite-wal ] && cp ~/Zotero/zotero.sqlite-wal "$D/data/"
ln -sfn ~/Zotero/storage "$D/data/storage"; cp -R ~/Zotero/translators ~/Zotero/styles "$D/data/"
(cd "$(dirname "$0")/runner" && rm -f "$D/profile/extensions/sb-test@local.xpi" && zip -q "$D/profile/extensions/sb-test@local.xpi" manifest.json bootstrap.js)
cat > "$D/profile/prefs.js" <<P
user_pref("extensions.zotero.dataDir", "$D/data");
user_pref("extensions.zotero.useDataDir", true);
user_pref("extensions.zotero.sync.autoSync", false);
user_pref("extensions.autoDisableScopes", 0);
P
echo "$D"
