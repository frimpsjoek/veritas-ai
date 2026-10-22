"""Keeps the tests off the machine's own setup: no data/sources.json, data/kb.sqlite or real Zotero library is read.

Set before any test module imports kb (which resolves the folder layout at import). Tests that need a layout build
their own in tmp_path; the stand-in library here only makes the Zotero routes answer instead of "needs Zotero".
"""
import os
import tempfile
from pathlib import Path

_scratch = Path(tempfile.mkdtemp(prefix="veritas-tests-"))
(_scratch / "Zotero").mkdir()
(_scratch / "Zotero" / "zotero.sqlite").write_bytes(b"")
os.environ["KB_SOURCES"] = str(_scratch / "sources.json")  # never created: the defaults below are used
os.environ["KB_ZOTERO"] = str(_scratch / "Zotero")
os.environ["KB_DB"] = str(_scratch / "kb.sqlite")  # never the server's own index (data/kb.sqlite)
os.environ.pop("KB_VAULT", None)
