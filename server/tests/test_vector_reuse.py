"""Moving a folder between main and listed (or editing one section) re-embeds only new text (phase 2 task 1b)."""
from __future__ import annotations

import numpy as np
import pytest

import kb
import sources


class CountingEmbedder:
    calls = 0
    mlx = None

    def __call__(self, texts, batch_size=16):
        CountingEmbedder.calls += len(texts)
        return np.array([[float(len(t) % 7), 1.0] + [0.0] * (kb.DIM - 2) for t in texts], dtype=np.float32)


@pytest.fixture
def notes(tmp_path, monkeypatch):
    vault = tmp_path / "notes"
    (vault / ".obsidian").mkdir(parents=True)
    (vault / "a.md").write_text("# A\n\n" + "Quasiparticle energies from GW. " * 40 + "\n\n## B\n\n" + "Band gaps. " * 60)
    (vault / "c.md").write_text("# C\n\n" + "Excitons in quantum dots. " * 50)
    monkeypatch.setattr(sources, "FILE", tmp_path / "data" / "sources.json")
    monkeypatch.setattr(sources, "OUTPUT_DEFAULT", tmp_path / "Veritas")
    monkeypatch.setattr(kb, "HOME", tmp_path)
    monkeypatch.setattr(kb, "DB_PATH", tmp_path / "data" / "kb.sqlite")
    monkeypatch.setattr(kb, "Embedder", CountingEmbedder)
    monkeypatch.setattr(kb, "index_zotero", lambda *a, **k: 0)
    monkeypatch.setattr(kb, "index_media", lambda *a, **k: 0)
    CountingEmbedder.calls = 0

    def layout(main: bool):
        sources.save([{"name": "notes", "path": str(vault), "enabled": True, "skip": [], **({"main": True} if main else {})}])
        monkeypatch.setattr(kb, "LAYOUT", sources.resolved())
        monkeypatch.setattr(kb, "VAULT", kb.LAYOUT.main)

    return vault, layout


def run():
    return kb._index(False, False, kb.Progress())


def test_moving_a_folder_reuses_its_vectors(notes):
    vault, layout = notes
    layout(main=True)
    first = run()
    assert first["embedded"] > 0 and CountingEmbedder.calls == first["embedded"]
    layout(main=False)  # the folder is now listed: every path gains "notes:/"
    second = run()
    assert second["changed"] == first["changed"]  # every note re-stored under its new path
    assert second["embedded"] == 0 and CountingEmbedder.calls == first["embedded"]
    db = kb.connect()
    assert db.execute("SELECT count(*) FROM vecs WHERE path LIKE 'notes:/%'").fetchone()[0] == first["embedded"]
    assert db.execute("SELECT count(*) FROM chunks").fetchone()[0] == db.execute("SELECT count(*) FROM vecs").fetchone()[0]


def test_editing_one_section_embeds_only_that_section(notes):
    vault, layout = notes
    layout(main=True)
    first = run()
    text = (vault / "a.md").read_text().replace("Band gaps. ", "Band offsets. ")
    (vault / "a.md").write_text(text)
    second = run()
    assert 0 < second["embedded"] < first["embedded"]


# A change to cleaning or chunking (CHUNKER_VERSION) re-chunks every document through store_note; passages whose
# text did not change keep their vectors.

REAL_INDEX_ZOTERO = kb.index_zotero
REAL_CLEAN = kb.clean


def stored_version():
    row = kb.connect().execute("SELECT value FROM meta WHERE key='chunker_version'").fetchone()
    return row[0] if row else None


def new_chunker(monkeypatch):
    """A next chunker version that changes one section's text ("Band gaps." -> "Band gaps!") and no other."""
    monkeypatch.setattr(kb, "CHUNKER_VERSION", kb.CHUNKER_VERSION + "-next")
    monkeypatch.setattr(kb, "clean", lambda text: REAL_CLEAN(text).replace("Band gaps.", "Band gaps!"))


def test_a_fresh_index_records_the_chunker_version(notes):
    vault, layout = notes
    layout(main=True)
    run()
    assert stored_version() == kb.CHUNKER_VERSION


def test_same_chunker_version_changes_nothing(notes):
    vault, layout = notes
    layout(main=True)
    run()
    second = run()
    assert second["changed"] == 0 and second["embedded"] == 0


def test_a_new_chunker_version_rechunks_every_note_and_reembeds_only_changed_text(notes, monkeypatch):
    vault, layout = notes
    layout(main=True)
    first = run()
    new_chunker(monkeypatch)
    second = run()
    assert second["changed"] == first["changed"] == 2  # both notes, though no file changed
    assert 0 < second["embedded"] < first["embedded"]  # only the "Band gaps!" chunks
    db = kb.connect()
    assert db.execute("SELECT count(*) FROM chunks WHERE text LIKE '%Band gaps!%'").fetchone()[0] > 0
    assert db.execute("SELECT count(*) FROM chunks WHERE text LIKE '%Band gaps.%'").fetchone()[0] == 0
    assert db.execute("SELECT count(*) FROM chunks").fetchone()[0] == db.execute("SELECT count(*) FROM vecs").fetchone()[0]
    assert stored_version() == kb.CHUNKER_VERSION
    third = run()
    assert third["changed"] == 0 and third["embedded"] == 0


def test_an_index_from_before_the_version_stamp_is_rechunked_keeping_its_vectors(notes):
    vault, layout = notes
    layout(main=True)
    first = run()
    db = kb.connect()
    db.execute("DELETE FROM meta WHERE key='chunker_version'")
    db.commit()
    second = run()
    assert second["changed"] == first["changed"] and second["embedded"] == 0
    assert stored_version() == kb.CHUNKER_VERSION


def test_a_new_chunker_version_rechunks_zotero_items(notes, monkeypatch):
    import zotero
    vault, layout = notes
    layout(main=True)
    doc = zotero.ZoteroDoc(key="ZKEY0001", title="Made-up paper on band gaps", tags=[], signature=5.0,
                           text="# Made-up paper\n\n## Abstract\n\n" + "Band gaps. " * 50 + "\n\n## Notes\n\n" + "Excitons. " * 50)
    monkeypatch.setattr(kb, "index_zotero", REAL_INDEX_ZOTERO)
    monkeypatch.setattr(kb, "LAYOUT", kb.LAYOUT.__class__(**{**vars(kb.LAYOUT), "libraries": []}))
    monkeypatch.setattr(zotero, "available", lambda: True)
    monkeypatch.setattr(zotero, "fingerprint", lambda: (1.0, 1.0))
    monkeypatch.setattr(zotero, "documents", lambda: [doc])
    monkeypatch.setattr(zotero, "collection_tree", lambda: [])
    first = run()
    assert first["zotero_changed"] == 1
    assert run()["zotero_changed"] == 0
    new_chunker(monkeypatch)
    second = run()
    assert second["zotero_changed"] == 1
    db = kb.connect()
    texts = [r[0] for r in db.execute("SELECT text FROM chunks WHERE path='zotero/ZKEY0001'")]
    assert any("Band gaps!" in t for t in texts) and not any("Band gaps." in t for t in texts)
    assert db.execute("SELECT count(*) FROM chunks").fetchone()[0] == db.execute("SELECT count(*) FROM vecs").fetchone()[0]
