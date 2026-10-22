#!/bin/sh
# Installs the search server as a LaunchAgent: it starts at login and restarts if it stops, so the phone can
# reach the index whenever the Mac is on. macOS asks once for access to the Documents folder: click Allow.
# Remove with: ./install-service.sh uninstall
set -e
LABEL=ai.veritas.server
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
KB="$(cd "$(dirname "$0")" && pwd)"  # this server folder

if [ "$1" = "uninstall" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
# bootout returns before the job is gone; bootstrapping too early fails with "5: Input/output error"
for _ in 1 2 3 4 5 6 7 8 9 10; do launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || break; sleep 0.5; done
  rm -f "$PLIST"
  echo "removed"
  exit 0
fi

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$KB/.venv/bin/python</string><string>$KB/kb.py</string><string>serve</string>
  </array>
  <key>WorkingDirectory</key><string>$KB</string>
  <key>EnvironmentVariables</key><dict>
    <!-- launchd's PATH is /usr/bin:/bin; the agent sidecar needs node, npx, codex and claude from here -->
    <key>PATH</key><string>$HOME/.local/bin:$HOME/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Standard</string>
  <key>StandardOutPath</key><string>$KB/data/serve.log</string>
  <key>StandardErrorPath</key><string>$KB/data/serve.log</string>
</dict></plist>
EOF
plutil -lint "$PLIST" >/dev/null
# A server started earlier by Obsidian or by hand holds the port; the service takes over from it.
# Started by hand it may read ".venv/bin/python kb.py serve" or "$KB/.venv/bin/python kb.py serve"; both match.
pkill -f "\.venv/bin/python .*kb\.py serve" 2>/dev/null || true
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "installed; if macOS asks about the Documents folder, click Allow"
