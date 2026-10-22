#!/bin/bash
# Installs dist/*.xpi into the live test profile and (re)starts headless Zotero. Clearing addonStartup.json.lz4
# is what makes Zotero notice a changed or newly added xpi.
D=${SB_LIVE_DIR:-$HOME/.cache/sb-live}; ROOT=$(cd "$(dirname "$0")/../.." && pwd)
pkill -f "$D/profile"; for i in 1 2 3 4 5 6 7 8; do pgrep -f "$D/profile" >/dev/null || break; sleep 1; done; pkill -9 -f "$D/profile"
cp "$(ls -t "$ROOT"/dist/*.xpi | head -1)" "$D/profile/extensions/second-brain@frimpsjoe.local.xpi"
rm -f "$D/profile/extensions.json" "$D/profile/addonStartup.json.lz4" "$D"/q/*; rm -rf "$D/profile/startupCache"
(SB_LIVE_DIR="$D" MOZ_HEADLESS=1 /Applications/Zotero.app/Contents/MacOS/zotero -profile "$D/profile" -no-remote -purgecaches > "$D/zotero.log" 2>&1 &)
echo 'await Zotero.uiReadyPromise; for (let i = 0; i < 50 && !Zotero.SecondBrain; i++) await Zotero.Promise.delay(200); return !!Zotero.SecondBrain;' > "$D/ready.js"
"$(dirname "$0")/run.sh" "$D/ready.js" 90
