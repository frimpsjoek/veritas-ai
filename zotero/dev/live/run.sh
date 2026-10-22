#!/bin/bash
# run.sh script.js [timeout-seconds]: runs the script inside the test Zotero (as an async function of Zotero, win)
D=${SB_LIVE_DIR:-$HOME/.cache/sb-live}; n=$(date +%s%N); cp "$1" "$D/q/$n.js"
for i in $(seq 1 $(( ${2:-60} * 5 ))); do [ -f "$D/q/$n.out" ] && { cat "$D/q/$n.out"; rm "$D/q/$n.out"; exit 0; }; sleep 0.2; done; echo TIMEOUT; exit 1
