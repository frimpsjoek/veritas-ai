"""kb's per-index settings as parameters (spec 035): each one defaults to the module global, read at call time, so
existing callers and tests that rebind kb.DB_PATH (and friends) behave as before, while a caller can name its own."""
from __future__ import annotations

import asyncio
import threading

import numpy as np
import pytest

import kb


def _vec(seed: int) -> bytes:
    return np.full(kb.DIM, seed, dtype=np.float16).tobytes()


def _store(db, rel: str, text: str, vec: bytes | None = None) -> None:
    kb.store_note(db, rel, "T", "", "personal", [], [], 1.0, len(text), "", None, text)  # one title: the stash key
    if vec is not None:
        for (cid,) in db.execute("SELECT id FROM chunks WHERE path=?", (rel,)):
            db.execute("INSERT OR REPLACE INTO vecs VALUES (?,?,?)", (cid, rel, vec))


def _vectors(db, rel: str) -> list[bytes]:
    return [r[0] for r in db.execute("SELECT vec FROM vecs WHERE path=?", (rel,))]


TEXT = "# T\n\n" + "Quasiparticle energies from the GW approximation. " * 10


# ---------------------------------------------------------------- Task 1: connect(path=), the vector stash

def test_connect_path_overrides_db_path(tmp_path, monkeypatch):
    monkeypatch.setattr(kb, "DB_PATH", tmp_path / "global" / "kb.sqlite")
    own = tmp_path / "own" / "kb.sqlite"
    db = kb.connect(keep=True, path=own)
    tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type IN ('table', 'index')")}
    db.close()
    assert own.exists()
    assert {"notes", "chunks", "vecs", "chunks_fts", "links", "meta", "collections", "media_cache"} <= tables
    assert not (tmp_path / "global" / "kb.sqlite").exists()


def test_connect_default_follows_monkeypatched_db_path(tmp_path, monkeypatch):
    monkeypatch.setattr(kb, "DB_PATH", tmp_path / "patched" / "kb.sqlite")
    kb.connect(keep=True).close()
    assert (tmp_path / "patched" / "kb.sqlite").exists()


def test_vector_stash_is_per_thread(tmp_path):
    db_a = kb.connect(keep=True, path=tmp_path / "a.sqlite")
    db_b = kb.connect(keep=True, path=tmp_path / "b.sqlite")
    _store(db_a, "note.md", TEXT, _vec(3))
    db_a.commit()
    stashed, stored = threading.Event(), threading.Event()
    errors: list[BaseException] = []

    def thread_a():
        try:
            with kb.vector_stash():
                kb.delete_note(db_a, "note.md")  # stashes T's vector in A's context
                stashed.set()
                stored.wait(5)
        except BaseException as error:  # noqa: BLE001
            errors.append(error)

    def thread_b():
        try:
            stashed.wait(5)
            with kb.vector_stash():
                _store(db_b, "note.md", TEXT)  # same text: must not pick up A's vector
            stored.set()
        except BaseException as error:  # noqa: BLE001
            errors.append(error)

    threads = [threading.Thread(target=thread_a), threading.Thread(target=thread_b)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(10)
    assert not errors
    assert _vectors(db_b, "note.md") == []
    db_a.close()
    db_b.close()


def test_vector_stash_not_shared_by_async_tasks(tmp_path):
    def worker(name: str, seed: int):
        db = kb.connect(keep=True, path=tmp_path / f"{name}.sqlite")
        try:
            text = TEXT + f" {name} only."
            with kb.vector_stash():
                _store(db, "old.md", text, _vec(seed))
                kb.delete_note(db, "old.md")
                own = dict(kb._VEC_STASH.get())
                _store(db, "new.md", text)
            return own, _vectors(db, "new.md")
        finally:
            db.close()

    async def main():
        return await asyncio.gather(asyncio.to_thread(worker, "x", 5), asyncio.to_thread(worker, "y", 7))

    with kb.vector_stash():
        outer = kb._VEC_STASH.get()
        outer["outer text"] = b"outer"
        (stash_x, vecs_x), (stash_y, vecs_y) = asyncio.run(main())
        assert kb._VEC_STASH.get() is outer and outer == {"outer text": b"outer"}
    assert len(stash_x) == len(stash_y) == 1
    assert all("x only" in key for key in stash_x) and all("y only" in key for key in stash_y)
    assert vecs_x == [_vec(5)] * len(vecs_x) and vecs_x
    assert vecs_y == [_vec(7)] * len(vecs_y) and vecs_y
    assert kb._VEC_STASH.get() is None


def test_stash_is_none_outside_a_write():
    assert kb._VEC_STASH.get() is None
    with kb.vector_stash():
        assert kb._VEC_STASH.get() == {}
    assert kb._VEC_STASH.get() is None


# ---------------------------------------------------------------- Task 2: backend choice, the shared embedder

def _tiny_model(folder):
    """A model folder with a real (tiny) tokenizer.json and an onnx/ folder; the session itself is faked."""
    from tokenizers import Tokenizer, models, pre_tokenizers

    words = ["[PAD]", "[UNK]", "represent", "this", "sentence", "quasiparticle", "energies", "gw"]
    tokenizer = Tokenizer(models.WordLevel({w: i for i, w in enumerate(words)}, unk_token="[UNK]"))
    tokenizer.pre_tokenizer = pre_tokenizers.Whitespace()
    folder.mkdir(parents=True, exist_ok=True)
    tokenizer.save(str(folder / "tokenizer.json"))
    (folder / "onnx").mkdir(exist_ok=True)
    return folder


class _Input:
    def __init__(self, name):
        self.name = name


class FakeSession:
    opened: list[str] = []

    def __init__(self, path, options=None, providers=None):
        FakeSession.opened.append(path)

    def get_inputs(self):
        return [_Input("input_ids"), _Input("attention_mask")]

    def run(self, outputs, feed):
        ids = feed["input_ids"]
        hidden = np.zeros((ids.shape[0], ids.shape[1], kb.DIM), dtype=np.float32)
        hidden[:, 0, 0] = 1.0
        return [hidden]


@pytest.fixture
def fake_onnx(monkeypatch):
    import onnxruntime

    FakeSession.opened = []
    monkeypatch.setattr(onnxruntime, "InferenceSession", FakeSession)
    return FakeSession


def test_resolve_backend(monkeypatch):
    monkeypatch.setattr(kb, "USE_MLX", True)
    assert kb.resolve_backend(None) == "mlx"
    monkeypatch.setattr(kb, "USE_MLX", False)
    assert kb.resolve_backend(None) == "onnx"
    monkeypatch.setattr(kb.sys, "platform", "linux")
    assert kb.resolve_backend("auto") == "onnx"
    monkeypatch.setattr(kb.sys, "platform", "darwin")
    assert kb.resolve_backend("auto") == "mlx"
    assert kb.resolve_backend("onnx") == "onnx" and kb.resolve_backend("mlx") == "mlx"
    with pytest.raises(ValueError):
        kb.resolve_backend("cuda")


def test_auto_backend_off_macos_never_tries_mlx(tmp_path, monkeypatch, fake_onnx, capsys):
    import sys

    model = _tiny_model(tmp_path / "model")
    monkeypatch.setattr(kb, "USE_MLX", True)  # the module default would try MLX; "auto" on Linux must not
    monkeypatch.setattr(kb.sys, "platform", "linux")
    monkeypatch.delitem(sys.modules, "mlx_embed", raising=False)
    embedder = kb.Embedder(model, "auto")
    assert embedder.mlx is None
    assert fake_onnx.opened == [str(model / "onnx" / "model.onnx")]
    assert "mlx_embed" not in sys.modules
    assert capsys.readouterr().err == ""
    vectors = embedder(["quasiparticle energies", "gw"], query=True)
    assert vectors.shape == (2, kb.DIM) and np.allclose(vectors[:, 0], 1.0)


def test_embedder_defaults_unchanged(tmp_path, monkeypatch, fake_onnx):
    model = _tiny_model(tmp_path / "models" / "snowflake-arctic-embed-s")
    monkeypatch.setattr(kb, "MODEL_DIR", model)
    monkeypatch.setattr(kb, "USE_MLX", False)
    embedder = kb.Embedder()
    assert embedder.mlx is None and fake_onnx.opened == [str(model / "onnx" / "model.onnx")]


class _FakeMX:
    """mlx.core, as much as mlx_embed touches outside forward(): no real MLX on Linux."""
    float16 = "float16"

    class array:
        def __init__(self, value):
            self.value = value

        def astype(self, dtype):
            return self

    @staticmethod
    def set_cache_limit(limit):
        pass


@pytest.fixture
def mlx_embed_stubbed(monkeypatch):
    """A private copy of mlx_embed imported against a stubbed mlx.core (sys.modules' mlx_embed untouched)."""
    import importlib.util
    import sys
    import types

    core = types.ModuleType("mlx.core")
    for name in ("float16", "array", "set_cache_limit"):
        setattr(core, name, getattr(_FakeMX, name))
    package = types.ModuleType("mlx")
    package.core = core
    monkeypatch.setitem(sys.modules, "mlx", package)
    monkeypatch.setitem(sys.modules, "mlx.core", core)
    spec = importlib.util.spec_from_file_location("mlx_embed_under_test", kb.HOME / "mlx_embed.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _mlx_weights():
    names = [f"encoder.layer.{i}.{p}.weight" for i in range(12) for p in
             ("attention.self.query", "attention.self.key", "attention.self.value", "attention.output.dense",
              "intermediate.dense", "output.dense")]
    return {name: np.zeros(1, dtype=np.float32) for name in names + ["embeddings.word_embeddings.weight"]}


def test_mlx_backend_gets_the_model_folder(tmp_path, monkeypatch, fake_onnx):
    """Review M3: the MLX weights come from `model_dir`, like the tokenizer, not from the default folder."""
    import sys
    import types

    model = _tiny_model(tmp_path / "other-model")
    built = []

    class ArcticMLX:
        def __init__(self, model_dir):
            built.append(model_dir)

    monkeypatch.setitem(sys.modules, "mlx_embed", types.SimpleNamespace(ArcticMLX=ArcticMLX))
    embedder = kb.Embedder(model, "mlx")
    assert embedder.mlx is not None and fake_onnx.opened == []  # no silent fall back to onnxruntime
    assert built == [model]


def test_mlx_weights_load_from_the_model_folder(tmp_path, monkeypatch, mlx_embed_stubbed):
    mlx_embed = mlx_embed_stubbed
    model = tmp_path / "other-model"
    model.mkdir()
    np.savez(model / "mlx-weights.npz", **_mlx_weights())
    loaded = mlx_embed.load(model)
    assert set(loaded) == set(_mlx_weights())
    arctic = mlx_embed.ArcticMLX(model)
    assert set(arctic.w) == set(_mlx_weights())
    asked = []
    monkeypatch.setattr(mlx_embed, "load", lambda model_dir=None: asked.append(model_dir) or _mlx_weights())
    mlx_embed.ArcticMLX(model), mlx_embed.ArcticMLX()
    assert asked == [model, None]  # None: the module's own folder, as before


def test_mlx_weights_extracted_from_the_model_folder(tmp_path, monkeypatch, mlx_embed_stubbed):
    import os
    import stat

    mlx_embed = mlx_embed_stubbed
    seen = []
    monkeypatch.setattr(mlx_embed, "extract", lambda model_dir: seen.append(model_dir) or _mlx_weights())
    model = tmp_path / "other-model"
    model.mkdir()
    assert set(mlx_embed.load(model)) == set(_mlx_weights())
    assert seen == [model] and (model / "mlx-weights.npz").exists()  # cached beside the ONNX file it came from
    read_only = tmp_path / "ro-model"
    read_only.mkdir()
    read_only.chmod(stat.S_IRUSR | stat.S_IXUSR)
    try:
        assert set(mlx_embed.load(read_only)) == set(_mlx_weights())  # extracted again, not cached
        assert os.listdir(read_only) == []
    finally:
        read_only.chmod(stat.S_IRWXU)


def test_onnx_model_folder_may_be_read_only(tmp_path, monkeypatch, fake_onnx):
    import os
    import stat

    model = _tiny_model(tmp_path / "ro-model")
    for path in (model / "onnx", model):
        path.chmod(stat.S_IRUSR | stat.S_IXUSR)
    try:
        before = sorted(os.listdir(model))
        kb.Embedder(model, "onnx")(["gw"])
        assert sorted(os.listdir(model)) == before
    finally:
        for path in (model, model / "onnx"):
            path.chmod(stat.S_IRWXU)


class SlowEmbedder:
    built = 0
    lock = threading.Lock()

    def __init__(self, model_dir=None, backend=None):
        import time

        time.sleep(0.2)
        with SlowEmbedder.lock:
            SlowEmbedder.built += 1
        self.model_dir, self.backend, self.mlx = model_dir, backend, None


@pytest.fixture
def no_shared(monkeypatch):
    monkeypatch.setattr(kb, "_EMBEDDERS", {})


def _in_threads(calls, timeout=10):
    results, errors = [None] * len(calls), [None] * len(calls)

    def run(i, call):
        try:
            results[i] = call()
        except BaseException as error:  # noqa: BLE001
            errors[i] = error

    threads = [threading.Thread(target=run, args=(i, c)) for i, c in enumerate(calls)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout)
    return results, errors


def test_shared_embedder_one_build_per_key_concurrently(tmp_path, monkeypatch, no_shared):
    SlowEmbedder.built = 0
    monkeypatch.setattr(kb, "Embedder", SlowEmbedder)
    d = tmp_path / "model"
    d.mkdir()
    calls = [lambda: kb.shared_embedder(d, "onnx")] * 4 + [lambda: kb.shared_embedder(d / ".", "onnx")] * 4
    results, errors = _in_threads(calls)
    assert errors == [None] * 8
    assert SlowEmbedder.built == 1
    assert all(r is results[0] for r in results)
    assert results[0].model_dir == d.resolve() and results[0].backend == "onnx"
    assert kb.shared_embedder(d, "onnx") is results[0]
    assert kb.shared_embedder(d, "mlx") is not results[0]  # another backend is another model


def test_shared_embedder_keys_do_not_wait_for_each_other(tmp_path, monkeypatch, no_shared):
    barrier = threading.Barrier(2, timeout=2)

    class MeetingEmbedder:
        mlx = None

        def __init__(self, model_dir=None, backend=None):
            barrier.wait()  # both builds must be in progress at once, or this times out

    monkeypatch.setattr(kb, "Embedder", MeetingEmbedder)
    (tmp_path / "d1").mkdir()
    (tmp_path / "d2").mkdir()
    results, errors = _in_threads([lambda: kb.shared_embedder(tmp_path / "d1", "onnx"),
                                   lambda: kb.shared_embedder(tmp_path / "d2", "onnx")])
    assert errors == [None, None]
    assert results[0] is not results[1]


def test_shared_embedder_failed_build_retries(tmp_path, monkeypatch, no_shared):
    attempts = []
    gate = threading.Event()

    class FlakyEmbedder:
        mlx = None

        def __init__(self, model_dir=None, backend=None):
            attempts.append(1)
            if len(attempts) == 1:
                gate.wait(5)
                raise OSError("model missing")

    monkeypatch.setattr(kb, "Embedder", FlakyEmbedder)
    d = tmp_path / "model"
    d.mkdir()

    def waiter():
        import time

        time.sleep(0.1)  # joins the first build while it is in flight
        return kb.shared_embedder(d, "onnx")

    def release():
        import time

        time.sleep(0.3)
        gate.set()

    results, errors = _in_threads([lambda: kb.shared_embedder(d, "onnx"), waiter, release])
    assert isinstance(errors[0], OSError) and isinstance(errors[1], OSError)
    assert len(attempts) == 1  # the waiter got the builder's error, it did not build again
    assert isinstance(kb.shared_embedder(d, "onnx"), FlakyEmbedder)
    assert len(attempts) == 2


def test_shared_embedder_thread_safe_encode(tmp_path, monkeypatch, fake_onnx, no_shared):
    model = _tiny_model(tmp_path / "model")
    embedder = kb.shared_embedder(model, "onnx")

    def work():
        for i in range(20):
            out = embedder(["quasiparticle energies gw"] * (1 + i % 5) + ["this sentence " * (i + 1)], query=i % 2 == 0)
            assert out.shape == (2 + i % 5, kb.DIM)
        return True

    results, errors = _in_threads([work] * 8, timeout=60)
    assert errors == [None] * 8 and results == [True] * 8
    assert fake_onnx.opened == [str(model.resolve() / "onnx" / "model.onnx")]


# ---------------------------------------------------------------- Task 3: Searcher and embed_pending take their index

MARKERS = ("alpha", "beta", "gamma", "delta")
FILLER = " Plain filler prose about nothing in particular, repeated to make one ordinary passage." * 4


class MarkerEmbedder:
    """Vectors from marker words found anywhere in the text (also inside longer tokens such as `zzalphazz`, which the
    keyword index never matches to a query word `alpha`): so a test can make vector-only hits. Never loads a model."""
    mlx = None

    def __init__(self):
        self.calls = 0

    def __call__(self, texts, query=False, batch_size=16):
        self.calls += len(texts)
        out = np.zeros((len(texts), kb.DIM), dtype=np.float32)
        for row, text in zip(out, texts):
            for i, marker in enumerate(MARKERS):
                if marker in text.lower():
                    row[i] = 1.0
            if not row.any():
                row[kb.DIM - 1] = 1.0
            row /= np.linalg.norm(row)
        return out


def _write(db_path, add=(), remove=(), embedder=None):
    """Store/remove notes as an index run would, embed them, stamp the index; returns the chunk ids of `add`."""
    db = kb.connect(keep=True, path=db_path)
    try:
        for rel in remove:
            kb.delete_note(db, rel)
        for rel, body in add:
            kb.store_note(db, rel, rel, "", "personal", [], [], 1.0, len(body), "", None, body)
        kb.stamp(db, "indexed_at")
        db.commit()
        kb.embed_pending(db, verbose=False, embedder=embedder or MarkerEmbedder())
        return {rel: [r[0] for r in db.execute("SELECT id FROM chunks WHERE path=?", (rel,))] for rel, _ in add}
    finally:
        db.close()


def _paths(results):
    return [r["path"] for r in results]


@pytest.fixture
def index(tmp_path, monkeypatch):
    """An index outside kb's own files; kb.DB_PATH and kb.HOME point at a folder that must stay empty."""
    monkeypatch.setattr(kb, "HOME", tmp_path / "global")
    monkeypatch.setattr(kb, "DB_PATH", tmp_path / "global" / "data" / "kb.sqlite")
    db_path, keyword_dir = tmp_path / "u" / "index" / "kb.sqlite", tmp_path / "u" / "index" / "tantivy"
    searchers = []

    def open_searcher(**kw):
        s = kb.Searcher(writer=True, db_path=db_path, keyword_dir=keyword_dir, embed_factory=MarkerEmbedder, **kw)
        searchers.append(s)
        return s

    yield db_path, keyword_dir, open_searcher
    for s in searchers:
        s.close()


def test_searcher_db_path_and_keyword_dir(index, tmp_path):
    db_path, keyword_dir, open_searcher = index
    searcher = open_searcher()
    _write(db_path, add=[("x.md", "# X\n\nXenon lamps zzalphazz." + FILLER)])
    assert _paths(searcher.search("xenon lamps")) == ["x.md"]
    searcher._rebuild()
    assert db_path.exists() and (keyword_dir / "meta.json").exists()
    assert not (tmp_path / "global").exists()
    assert not kb.data_dir().joinpath("tantivy").exists()


def test_searcher_vector_gate_override(index):
    db_path, _, open_searcher = index
    _write(db_path, add=[("ab.md", "# AB\n\nzzalphazz zzbetazz." + FILLER)])  # cosine 0.71 to an alpha query
    assert _paths(open_searcher().search("near alpha")) == ["ab.md"]
    assert open_searcher(vector_gate=0.99).search("near alpha") == []


def test_embed_pending_uses_given_embedder(tmp_path, monkeypatch):
    def no_model(*a, **k):
        raise AssertionError("kb.Embedder must not be built")

    monkeypatch.setattr(kb, "Embedder", no_model)
    db = kb.connect(keep=True, path=tmp_path / "kb.sqlite")
    kb.store_note(db, "a.md", "A", "", "personal", [], [], 1.0, 10, "", None, "# A\n\nzzalphazz" + FILLER)
    db.commit()
    embedder = MarkerEmbedder()
    assert kb.embed_pending(db, verbose=False, embedder=embedder) == embedder.calls > 0
    assert db.execute("SELECT count(*) FROM vecs").fetchone()[0] == embedder.calls
    db.close()


def test_stats_on_a_given_connection(tmp_path):
    db = kb.connect(keep=True, path=tmp_path / "kb.sqlite")
    kb.store_note(db, "a.md", "A", "", "personal", [], [], 1.0, 10, "", None, "# A\n\ntext" + FILLER)
    db.commit()
    stats = kb.stats(db)
    assert stats["notes"] == 1 and stats["chunks"] >= 1 and stats["chunks_with_vectors"] == 0
    db.close()


def test_changed_sees_writes_at_once(index):
    db_path, _, open_searcher = index
    _write(db_path, add=[("x.md", "# X\n\nXenon lamps zzalphazz." + FILLER)])
    searcher = open_searcher()
    assert _paths(searcher.search("xenon")) == ["x.md"]
    _write(db_path, add=[("y.md", "# Y\n\nYttrium garnets zzbetazz." + FILLER)])
    assert searcher.search("yttrium") == []  # within a minute of the last check: not looked at yet
    searcher.changed()
    assert _paths(searcher.search("yttrium")) == ["y.md"]


def _replace_with_reuse(db_path):
    """x.md (alpha, the highest chunk id) replaced by y.md (gamma), which gets x.md's chunk id back."""
    old = _write(db_path, remove=["x.md"], add=[("y.md", "# Y\n\nYttrium zzgammazz." + FILLER)])
    return old["y.md"]


def test_reused_chunk_id_gets_fresh_vector(index):
    db_path, _, open_searcher = index
    _write(db_path, add=[("keep.md", "# K\n\nzzdeltazz." + FILLER)])
    x_ids = _write(db_path, add=[("x.md", "# X\n\nXenon zzalphazz." + FILLER)])["x.md"]
    searcher = open_searcher()
    assert _paths(searcher.search("near alpha")) == ["x.md"]
    y_ids = _replace_with_reuse(db_path)
    assert y_ids == x_ids  # SQLite gave the new chunk the deleted one's id
    searcher.changed(full=True, replaced=x_ids)
    assert _paths(searcher.search("near gamma")) == ["y.md"]
    assert searcher.search("near alpha") == []


def test_reused_chunk_id_gets_fresh_keywords(index):
    db_path, _, open_searcher = index
    x_ids = _write(db_path, add=[("x.md", "# X\n\nXenon lamps zzbetazz." + FILLER)])["x.md"]
    searcher = open_searcher()
    assert _paths(searcher.search("xenon")) == ["x.md"]
    _replace_with_reuse(db_path)
    searcher.changed(full=True, replaced=x_ids)
    assert _paths(searcher.search("yttrium")) == ["y.md"]
    assert searcher.search("xenon") == []


class _BlockShadowLoad:
    """Makes the background rebuild's shadow block after it read the index, until released."""

    def __init__(self, monkeypatch, searcher):
        self.read, self.release = threading.Event(), threading.Event()
        original = kb.Searcher._load

        def load(this, full):
            original(this, full)
            if this is not searcher:
                self.read.set()
                self.release.wait(10)

        monkeypatch.setattr(kb.Searcher, "_load", load)


def test_write_during_rebuild_is_not_lost(index, monkeypatch):
    db_path, _, open_searcher = index
    _write(db_path, add=[("keep.md", "# K\n\nzzdeltazz." + FILLER)])
    x_ids = _write(db_path, add=[("x.md", "# X\n\nXenon zzalphazz." + FILLER)])["x.md"]
    searcher = open_searcher()
    assert _paths(searcher.search("near alpha")) == ["x.md"]
    block = _BlockShadowLoad(monkeypatch, searcher)
    searcher._start_rebuild()
    assert block.read.wait(5)  # the shadow holds the old matrix (x.md's vector at the id y.md is about to reuse)
    _replace_with_reuse(db_path)
    searcher.changed(full=True, replaced=x_ids)
    block.release.set()
    searcher._rebuild_thread.join(5)
    assert _paths(searcher.search("near gamma")) == ["y.md"]
    assert searcher.search("near alpha") == []


def test_changed_during_refresh_forces_full_load(index):
    db_path, _, open_searcher = index
    _write(db_path, add=[("x.md", "# X\n\nXenon zzalphazz." + FILLER)])
    searcher = open_searcher()
    original, calls = searcher._load, []

    def load(full):
        calls.append(full)
        original(full)
        if len(calls) == 1:
            searcher.changed(full=True)  # a write lands while this refresh runs

    searcher._load = load
    searcher.search("xenon")
    searcher.search("xenon")
    assert calls == [True, True]


def test_searcher_close_waits_for_rebuild(index, monkeypatch):
    import sqlite3
    import time

    db_path, _, open_searcher = index
    _write(db_path, add=[("x.md", "# X\n\nXenon zzalphazz." + FILLER)])
    searcher = open_searcher()
    searcher.search("xenon")
    block = _BlockShadowLoad(monkeypatch, searcher)
    searcher._start_rebuild()
    assert block.read.wait(5)
    closer = threading.Thread(target=searcher.close)
    closer.start()
    time.sleep(0.2)
    assert closer.is_alive()  # waits for the rebuild
    block.release.set()
    closer.join(5)
    assert not closer.is_alive() and not searcher._rebuild_thread.is_alive()
    with pytest.raises(sqlite3.ProgrammingError):
        searcher.db.execute("SELECT 1")
    searcher.close()  # a second close is a no-op
    searcher._start_rebuild()
    assert not searcher._rebuild_thread.is_alive()  # never starts after close
