"""zotero_files.py: Zotero's prefs are looked up when needed, not when the module is imported (spec 024 G2)."""
from __future__ import annotations

import sources
import zotero_files


def test_base_folder_comes_from_the_prefs_found_at_call_time(tmp_path, monkeypatch):
    monkeypatch.setattr(sources, "ZOTERO_PROFILES", tmp_path / "Profiles")
    assert zotero_files.current_base() == ""
    prefs = tmp_path / "Profiles" / "abc.default" / "prefs.js"
    prefs.parent.mkdir(parents=True)
    prefs.write_text('user_pref("extensions.zotero.baseAttachmentPath", "/data/papers");\n')
    assert zotero_files.current_base() == "/data/papers"


def test_pdf_listing_without_find(tmp_path):
    """Windows has no Unix `find`: the listing is walked in Python there, with the same filters."""
    (tmp_path / "a").mkdir()
    (tmp_path / "a" / "Paper.PDF").write_bytes(b"%PDF-" + b"x" * 2000)
    (tmp_path / "a" / "tiny.pdf").write_bytes(b"%PDF-")
    (tmp_path / ".Trash").mkdir()
    (tmp_path / ".Trash" / "old.pdf").write_bytes(b"%PDF-" + b"x" * 2000)
    assert zotero_files.walk_pdfs([str(tmp_path)]) == [str(tmp_path / "a" / "Paper.PDF")]
