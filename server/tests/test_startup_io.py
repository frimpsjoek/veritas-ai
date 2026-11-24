"""Importing kb lists no listed folder. On 2026-11-03 the desktop app's server hung four times in opendir while
importing kb (a stuck macOS permission prompt for ~/Documents, most likely): the folder list was resolved at import and
every listed folder, disabled ones too, was walked to tell a PDF folder from a notes folder. Now the walk waits until a
folder's kind is first asked for, so the server listens whatever the folders do."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

SERVER = Path(__file__).resolve().parents[1]

# Runs in a fresh process: an audit hook sees every directory listing (os.walk and Path.iterdir both use os.scandir)
# under the folder given, then kb is imported as the server does at start.
PROBE = r"""
import json, sys
watched = sys.argv[1]
touched = []
def hook(event, args):
    if event in ("os.scandir", "os.listdir") and args and str(args[0]).startswith(watched):
        touched.append(f"{event} {args[0]}")
sys.addaudithook(hook)
import kb
print(json.dumps({"touched": touched, "vault": str(kb.VAULT), "others": [f.name for f in kb.LAYOUT.others],
                  "zotero": str(kb.LAYOUT.zotero), "ignored": [f.name for f in kb.LAYOUT.ignored]}))
"""


def test_importing_kb_lists_no_listed_folder(tmp_path):
    documents = tmp_path / "Documents"
    vault = documents / "Vault"
    (vault / ".obsidian").mkdir(parents=True)
    notes = documents / "Notes"  # a plain folder: only a walk can tell it from a PDF folder
    (notes / "a").mkdir(parents=True)
    (notes / "a" / "x.md").write_text("# x\n")
    off = documents / "Off"
    off.mkdir()
    library = documents / "Zotero"
    library.mkdir()
    (library / "zotero.sqlite").write_bytes(b"")
    listed = tmp_path / "sources.json"
    listed.write_text(json.dumps({"version": 1, "folders": [
        {"name": "vault", "path": str(vault), "enabled": True, "skip": [], "main": True},
        {"name": "notes", "path": str(notes), "enabled": True, "skip": []},
        {"name": "off", "path": str(off), "enabled": False, "skip": []},
        {"name": "gone", "path": str(documents / "Gone"), "enabled": True, "skip": []},
        {"name": "zotero", "path": str(library), "enabled": True, "skip": []},
    ]}))
    env = {**os.environ, "KB_SOURCES": str(listed), "KB_DB": str(tmp_path / "kb.sqlite"), "KB_BACKEND": "onnx"}
    out = subprocess.run([sys.executable, "-c", PROBE, str(documents)], cwd=SERVER, env=env, capture_output=True,
                         text=True, timeout=120)
    assert out.returncode == 0, out.stderr
    seen = json.loads(out.stdout.strip().splitlines()[-1])
    assert seen["touched"] == []
    # the layout is the same as before: the main folder, the other notes folders, the library, the missing one
    assert seen["vault"] == str(vault) and seen["others"] == ["notes"]
    assert seen["zotero"] == str(library) and seen["ignored"] == ["gone"]
