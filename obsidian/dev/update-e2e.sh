#!/bin/sh
# Two-hop auto-update test in a throwaway Obsidian (own --user-data-dir, own vault, stub server). Never touches the
# real vault or the live kb server. Run before publishing any build: ./dev/update-e2e.sh
# Installs the current dist-versions/<manifest version> as N, then serves N+1 and N+2 (same code, bumped manifest).
set -e
dev="$(cd "$(dirname "$0")" && pwd)"; here="$dev/update-e2e"; plugin="$(dirname "$dev")"; kb="$(dirname "$plugin")"
dbg=9333; port=27999; id=second-brain-search
work="$(mktemp -d)"; base="$(node -p 'require("'"$plugin"'/manifest.json").version')"
next() { echo "$1" | awk -F. '{printf "%d.%d.%d", $1, $2, $3+1}'; }
v1="$(next "$base")"; v2="$(next "$v1")"
cleanup() {
	pkill -f "user-data-dir=$work/udd" 2>/dev/null || true; kill "$stub" 2>/dev/null || true
	while pgrep -f "user-data-dir=$work/udd" >/dev/null; do sleep 1; done
	rm -rf "$work"
}
trap cleanup EXIT
for p in $port $dbg; do ! lsof -nP -iTCP:$p -sTCP:LISTEN >/dev/null || { echo "port $p already in use"; exit 1; }; done
mkdir -p "$work/zdist" "$work/odist" "$work/hidden" "$work/udd" "$work/vault/.obsidian/plugins/$id"
src="$plugin/dist-versions/$base"; [ -d "$src" ] || { echo "no $src (run install.sh first)"; exit 1; }
mkdir "$work/odist/$base"; cp "$src"/* "$work/odist/$base/"; : > "$work/zdist/second-brain-$base.xpi"
for v in "$v1" "$v2"; do
	mkdir "$work/hidden/$v"; cp "$src/main.js" "$src/styles.css" "$work/hidden/$v/"
	sed "s/$base/$v/" "$src/manifest.json" > "$work/hidden/$v/manifest.json"; echo "/*build $v*/" >> "$work/hidden/$v/main.js"
	: > "$work/zdist/second-brain-$v.xpi"
done
cp "$src"/* "$work/vault/.obsidian/plugins/$id/"
echo "{\"startServer\":false,\"port\":$port,\"updates\":\"server\"}" > "$work/vault/.obsidian/plugins/$id/data.json"
echo "[\"$id\"]" > "$work/vault/.obsidian/community-plugins.json"; echo '{}' > "$work/vault/.obsidian/app.json"
echo "{\"vaults\":{\"e2e0000000001\":{\"path\":\"$work/vault\",\"ts\":1790000000000,\"open\":true}}}" > "$work/udd/obsidian.json"
python3 "$here/stub.py" "$kb" "$work/zdist" "$work/odist" "$port" > "$work/stub.log" 2>&1 & stub=$!
open -n -g -a Obsidian --args --user-data-dir="$work/udd" --remote-debugging-port=$dbg
i=0; until curl -s -m 1 "localhost:$dbg/json" | grep -q index.html; do i=$((i+1)); [ $i -gt 30 ] && { echo "Obsidian did not start"; exit 1; }; sleep 1; done
ev() { node "$here/cdp.mjs" $dbg "$1"; }
state='(async()=>{const id="'$id'";return JSON.stringify({manifest:app.plugins.manifests[id]?.version,running:app.plugins.plugins[id]?.manifest.version,disk:JSON.parse(await app.vault.adapter.read(".obsidian/plugins/"+id+"/manifest.json")).version})})()'
check='(async()=>await app.plugins.plugins["'$id'"].updater.checkNow())()'
want() { got="$(ev "$state" | sed 's/\\//g; s/^"//; s/"$//')"; [ "$got" = "{\"manifest\":\"$1\",\"running\":\"$1\",\"disk\":\"$1\"}" ] || { echo "FAIL: expected $1 everywhere, got $got"; exit 1; }; echo "ok: $1"; }
i=0; until ev '!!app.plugins.plugins["'$id'"]?.updater' | grep -q true; do i=$((i+1)); [ $i -gt 30 ] && { echo "plugin did not load"; exit 1; }; sleep 1; done
want "$base"
for v in "$v1" "$v2"; do
	mv "$work/hidden/$v" "$work/odist/"; ev "$check" >/dev/null; sleep 8; want "$v"
done
sleep 20; want "$v2"; echo "stable after 20s (no reload loop)"
downloads=$(grep -c "obsidian/file" "$work/stub.log" || true); [ "$downloads" -eq 6 ] || { echo "FAIL: expected 6 file downloads, saw $downloads"; exit 1; }
echo "PASS: $base -> $v1 -> $v2"
