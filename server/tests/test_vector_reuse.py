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
