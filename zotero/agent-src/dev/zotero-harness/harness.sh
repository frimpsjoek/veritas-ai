#!/bin/sh
# Headless Zotero for testing the plugin without touching the real Zotero, profile or library.
#
#   harness.sh setup <dir>                 scratch profile + a copy of the library in <dir>
#   harness.sh run <dir> <test.js> [secs]  install the current plugin, run one test script, print out.txt
#   harness.sh stop <dir>                  kill the headless Zotero
#
# Env: SB_SERVER (the Second Brain server URL the plugin should use; point it at a dead port to test Zotero
# alone), ZOTERO_DATA (the library to copy, default ~/Zotero), SB_PORT (Zotero's HTTP port, default 23191).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../.." && pwd)
zotero=/Applications/Zotero.app/Contents/MacOS/zotero
cmd=${1:?usage: harness.sh setup|run|stop <dir>}
dir=${2:?usage: harness.sh setup|run|stop <dir>}
mkdir -p "$dir"
dir=$(cd "$dir" && pwd)
case "$dir" in /|"$HOME"|"$HOME/Zotero"*) echo "refusing to use $dir" >&2; exit 1 ;; esac

stop() {
	if [ -f "$dir/pid" ]; then
		pid=$(cat "$dir/pid")
		kill "$pid" 2>/dev/null || true
		for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
		kill -9 "$pid" 2>/dev/null || true
		rm -f "$dir/pid"
	fi
}

case "$cmd" in
setup)
	stop
	src=${ZOTERO_DATA:-$HOME/Zotero}
	rm -rf "$dir/profile" "$dir/data"
	mkdir -p "$dir/profile/extensions" "$dir/data/second-brain"
	# The database is in WAL mode: without the -wal file the copy misses recent changes.
	cp "$src/zotero.sqlite" "$dir/data/"
	[ -f "$src/zotero.sqlite-wal" ] && cp "$src/zotero.sqlite-wal" "$dir/data/"
	# Full-text caches only (no PDFs), and the built-in search model with its saved vectors.
	rsync -a --include='*/' --include='.zotero-ft-cache' --exclude='*' "$src/storage/" "$dir/data/storage/"
	for part in model runtime index; do
		[ -d "$src/second-brain/$part" ] && cp -cR "$src/second-brain/$part" "$dir/data/second-brain/"
	done
	cat > "$dir/profile/prefs.js" <<PREFS
user_pref("extensions.zotero.dataDir", "$dir/data");
user_pref("extensions.zotero.useDataDir", true);
user_pref("extensions.zotero.httpServer.port", ${SB_PORT:-23191});
user_pref("extensions.autoDisableScopes", 0);
user_pref("extensions.zotero.firstRun2", false);
user_pref("extensions.zotero.firstRunGuidance", false);
user_pref("extensions.zotero.sync.autoSync", false);
user_pref("browser.dom.window.dump.enabled", true);
PREFS
	echo "set up $dir"
	;;
run)
	test=$(cd "$(dirname "${3:?test script}")" && pwd)/$(basename "$3")
	secs=${4:-240}
	stop
	(cd "$repo" && rm -f "$dir/plugin.xpi" && zip -qr "$dir/plugin.xpi" manifest.json bootstrap.js content locale -x '*.DS_Store')
	cp "$dir/plugin.xpi" "$dir/profile/extensions/second-brain@frimpsjoe.local.xpi"
	(cd "$here/runner" && rm -f "$dir/runner.xpi" && zip -qr "$dir/runner.xpi" manifest.json bootstrap.js)
	cp "$dir/runner.xpi" "$dir/profile/extensions/sb-test@local.xpi"
	cat > "$dir/profile/user.js" <<PREFS
user_pref("extensions.sbtest.script", "$test");
user_pref("extensions.sbtest.out", "$dir/out.txt");
user_pref("extensions.secondbrain.server", "${SB_SERVER:-http://127.0.0.1:27182}");
PREFS
	rm -f "$dir/out.txt"
	MOZ_HEADLESS=1 "$zotero" -profile "$dir/profile" -no-remote -purgecaches -ZoteroDebugText > "$dir/zotero.log" 2>&1 &
	echo $! > "$dir/pid"
	end=$(( $(date +%s) + secs ))
	while [ "$(date +%s)" -lt "$end" ]; do
		grep -q '^DONE' "$dir/out.txt" 2>/dev/null && break
		sleep 2
	done
	stop
	cat "$dir/out.txt" 2>/dev/null || echo "no out.txt; see $dir/zotero.log"
	grep -q '^DONE pass=[0-9]* fail=0$' "$dir/out.txt" 2>/dev/null
	;;
stop)
	stop
	;;
*)
	echo "usage: harness.sh setup|run|stop <dir>" >&2
	exit 2
	;;
esac
