"""Spec 036: a faster, leaner build. Repeated passages are embedded once (R4); the ONNX fallback runs a fused copy of
the model only when its vectors match the original (R3); batches of EMBED_BATCH (R2, R3)."""
from __future__ import annotations

import os
import sys
import types

import numpy as np
import pytest

import kb
import sources


class Recorder:
    texts: list[str] = []
    sizes: list[int] = []
    mlx = None

    def __call__(self, texts, batch_size=16):
        Recorder.texts += list(texts)
        Recorder.sizes.append(batch_size)
        return np.array([[float(hash(t) % 97), 1.0] + [0.0] * (kb.DIM - 2) for t in texts], dtype=np.float32)


@pytest.fixture
def library(tmp_path, monkeypatch):
    vault = tmp_path / "notes"
    (vault / ".obsidian").mkdir(parents=True)
    same = "## Methods\n\n" + "We relax the slab with PBE and a 4x4x1 k-point grid. " * 30
    for name in ("a", "b", "c"):  # three copies of one section (a paper and its copies)
        (vault / f"{name}.md").write_text(same)
    (vault / "d.md").write_text("## Other\n\n" + "Something else entirely about excitons. " * 30)
    monkeypatch.setattr(sources, "FILE", tmp_path / "data" / "sources.json")
    monkeypatch.setattr(sources, "OUTPUT_DEFAULT", tmp_path / "Veritas")
    monkeypatch.setattr(kb, "HOME", tmp_path)
    monkeypatch.setattr(kb, "DB_PATH", tmp_path / "data" / "kb.sqlite")
    monkeypatch.setattr(kb, "Embedder", Recorder)
    monkeypatch.setattr(kb, "index_zotero", lambda *a, **k: 0)
    monkeypatch.setattr(kb, "index_media", lambda *a, **k: 0)
    sources.save([{"name": "notes", "path": str(vault), "enabled": True, "skip": [], "main": True}])
    monkeypatch.setattr(kb, "LAYOUT", sources.resolved())
    monkeypatch.setattr(kb, "VAULT", kb.LAYOUT.main)
    Recorder.texts, Recorder.sizes = [], []
    return vault


def test_a_repeated_passage_is_embedded_once_and_every_copy_gets_its_vector(library, monkeypatch):
    # the embedded text includes the title: copies of one paper share title and text, so give the three one title
    kb._index(False, False, kb.Progress())
    db = kb.connect()
    db.execute("DELETE FROM vecs")
    db.execute("UPDATE notes SET title='Same paper' WHERE path IN ('a.md','b.md','c.md')")
    db.commit()
    Recorder.texts = []
    embedded = kb.embed_pending(db, verbose=False, batch=2)  # copies fall in different DB batches
    chunks = db.execute("SELECT count(*) FROM chunks").fetchone()[0]
    assert embedded == chunks == db.execute("SELECT count(*) FROM vecs").fetchone()[0]
    distinct = db.execute("SELECT count(*) FROM (SELECT DISTINCT n.title, c.heading, c.text FROM chunks c "
                          "JOIN notes n ON n.path=c.path)").fetchone()[0]
    assert distinct < chunks  # the three copies share their passages
    assert len(Recorder.texts) == len(set(Recorder.texts)) == distinct  # each distinct text embedded once
    copies = db.execute("SELECT c.ord, v.vec FROM vecs v JOIN chunks c ON c.id=v.id WHERE c.path IN ('a.md','b.md','c.md')").fetchall()
    for ord_ in {o for o, _ in copies}:  # the same passage of each copy has the same vector
        assert len({vec for o, vec in copies if o == ord_}) == 1
    assert set(Recorder.sizes) == {kb.EMBED_BATCH}


@pytest.fixture
def model_dir(tmp_path, monkeypatch):
    (tmp_path / "onnx").mkdir()
    (tmp_path / "onnx" / "model.onnx").write_bytes(b"original")
    monkeypatch.setattr(kb, "MODEL_DIR", tmp_path)
    saved = []

    class Model:
        def save_model_to_file(self, path):
            saved.append(path)
            open(path, "wb").write(b"fused")

    optimizer = types.SimpleNamespace(optimize_model=lambda *a, **k: Model())
    package = types.ModuleType("onnxruntime.transformers")
    package.optimizer = optimizer
    monkeypatch.setitem(sys.modules, "onnxruntime.transformers", package)
    monkeypatch.setitem(sys.modules, "onnxruntime.transformers.optimizer", optimizer)
    monkeypatch.delenv("KB_FUSE", raising=False)
    return tmp_path, saved


def test_the_fused_model_is_made_once_when_its_vectors_match(model_dir, monkeypatch):
    folder, saved = model_dir
    monkeypatch.setattr(kb, "_fused_cosine", lambda a, b, o: 0.99999)
    assert kb.onnx_model() == folder / "onnx" / "model-fused.onnx"
    assert (folder / "onnx" / "model-fused.onnx").read_bytes() == b"fused"
    assert kb.onnx_model() == folder / "onnx" / "model-fused.onnx" and len(saved) == 1
    assert not list((folder / "onnx").glob("*.tmp"))


def test_a_fused_model_that_differs_is_not_used_and_not_tried_again_until_the_code_changes(model_dir, monkeypatch):
    folder, saved = model_dir
    monkeypatch.setattr(kb, "_fused_cosine", lambda a, b, o: 0.98)
    assert kb.onnx_model() == folder / "onnx" / "model.onnx"
    assert not (folder / "onnx" / "model-fused.onnx").exists() and (folder / "onnx" / "model-fused.failed").exists()
    assert kb.onnx_model() == folder / "onnx" / "model.onnx" and len(saved) == 1
    marker = folder / "onnx" / "model-fused.failed"
    old = os.stat(kb.__file__).st_mtime - 10
    os.utime(marker, (old, old))  # an update brought newer code: try again
    kb.onnx_model()
    assert len(saved) == 2


def test_no_onnx_package_keeps_the_original(model_dir, monkeypatch):
    folder, _ = model_dir
    monkeypatch.setitem(sys.modules, "onnxruntime.transformers", None)
    assert kb.onnx_model() == folder / "onnx" / "model.onnx"


def model_present() -> bool:
    return (kb.MODEL_DIR / "onnx" / "model.onnx").exists() and (kb.MODEL_DIR / "tokenizer.json").exists()


@pytest.mark.skipif(not model_present(), reason="needs the downloaded model")
def test_the_real_fused_model_gives_the_same_vectors(tmp_path):
    pytest.importorskip("onnx")
    import onnxruntime
    fused = tmp_path / "fused.onnx"
    from onnxruntime.transformers import optimizer
    optimizer.optimize_model(str(kb.MODEL_DIR / "onnx" / "model.onnx"), model_type="bert", num_heads=12,
                             hidden_size=kb.DIM, opt_level=0).save_model_to_file(str(fused))
    assert kb._fused_cosine(kb.MODEL_DIR / "onnx" / "model.onnx", fused, onnxruntime.SessionOptions()) >= kb.FUSED_MIN_COSINE
