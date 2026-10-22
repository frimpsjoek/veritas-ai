"""Source kinds behind a connector registry (phase 2 task 2)."""
from __future__ import annotations

from pathlib import Path

import connectors
import sources


def test_detect_order(tmp_path):
    both = tmp_path / "both"
    (both / ".obsidian").mkdir(parents=True)
    (both / "zotero.sqlite").write_bytes(b"")
    assert connectors.detect(both) == "zotero"
    vault = tmp_path / "vault"
    (vault / ".obsidian").mkdir(parents=True)
    assert connectors.detect(vault) == "obsidian"
    notes = tmp_path / "notes"
    notes.mkdir()
    (notes / "a.md").write_text("# a\n")
    (notes / "b.pdf").write_bytes(b"%PDF")
    assert connectors.detect(notes) == "plain"
    assert connectors.detect(tmp_path / "gone") == "missing"
    assert sources.detect(vault) == "obsidian"  # sources delegates to the registry


def test_pdf_folder_kind(tmp_path):
    pdfs = tmp_path / "pdfs"
    (pdfs / "sub").mkdir(parents=True)
    (pdfs / "sub" / "paper.PDF").write_bytes(b"%PDF")
    assert connectors.detect(pdfs) == "pdf"
    assert connectors.REGISTRY["pdf"].indexed_as == "plain"
    empty = tmp_path / "empty"
    empty.mkdir()
    assert connectors.detect(empty) == "plain"


def test_register_new_kind_is_detected(tmp_path, monkeypatch):
    monkeypatch.setattr(connectors, "REGISTRY", dict(connectors.REGISTRY))
    folder = tmp_path / "lab"
    folder.mkdir()
    (folder / "eln.json").write_text("{}")
    connectors.register(connectors.Connector("eln", "Lab notebook export", lambda p: (p / "eln.json").is_file(),
                                             indexed_as="plain"), first=True)
    assert connectors.detect(folder) == "eln"
    assert sources.detect(folder) == "eln"


def test_registry_lists_launch_kinds():
    assert {"zotero", "obsidian", "pdf", "plain"} <= set(connectors.REGISTRY)
    assert connectors.REGISTRY["zotero"].can_add_items and not connectors.REGISTRY["plain"].can_add_items
    assert connectors.REGISTRY["obsidian"].writes_notes and not connectors.REGISTRY["pdf"].writes_notes
