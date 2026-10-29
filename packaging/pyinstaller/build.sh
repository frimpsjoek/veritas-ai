#!/bin/sh
# Builds the server as one executable (spec 024 G3) and copies it to where the desktop app bundles it:
# app/src-tauri/binaries/veritas-server-<target triple>[.exe] (Tauri's externalBin naming).
#   PYTHON=/path/to/python  a Python 3.12 with server/requirements.txt and pyinstaller (default: .venv-build here)
set -e
cd "$(dirname "$0")"
here=$PWD
if [ -z "$PYTHON" ]; then
  [ -x .venv-build/bin/python ] || { uv venv .venv-build --python 3.12 && uv pip install --python .venv-build/bin/python -r ../../server/requirements.txt pyinstaller; }
  PYTHON=$here/.venv-build/bin/python
fi
"$PYTHON" -m PyInstaller --noconfirm --clean --distpath dist --workpath build veritas-server.spec
triple=${TARGET_TRIPLE:-$(rustc -vV 2>/dev/null | sed -n 's/^host: //p')}
[ -n "$triple" ] || { echo "build.sh: set TARGET_TRIPLE (no rustc to ask)" >&2; exit 1; }
ext=""; case "$triple" in *windows*) ext=".exe" ;; esac
mkdir -p ../../app/src-tauri/binaries
cp "dist/veritas-server$ext" "../../app/src-tauri/binaries/veritas-server-$triple$ext"
echo "server sidecar: app/src-tauri/binaries/veritas-server-$triple$ext ($(du -h "dist/veritas-server$ext" | cut -f1))"
