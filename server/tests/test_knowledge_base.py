"""veritas_kb.KnowledgeBase (spec 035): several independent indexes in one process. Paths follow the tenant layout
<user>/knowledgebase/zotero/index/{kb.sqlite,tantivy}. Embedders are fakes; no model is loaded."""
from __future__ import annotations

import os
import re
import socket
import sqlite3
import subprocess
import sys
import threading
import time
import zlib
from pathlib import Path

import numpy as np
import pytest

import kb
import veritas_kb
from veritas_kb import ClosedError, ConcurrentUseError, Document, KnowledgeBase

SERVER = Path(__file__).resolve().parent.parent


class HashEmbedder:
    """Words hashed into a 384-d bag (bench.HashEmbedder), the query prefix ignored: texts sharing words are close."""
    mlx = None

    def __init__(self):
        self.calls = 0
        self.lock = threading.Lock()

    def vector(self, text: str) -> np.ndarray:
        row = np.zeros(kb.DIM, dtype=np.float32)
        for word in re.findall(r"[a-z]+", text.lower()):
            row[zlib.crc32(word.encode()) % kb.DIM] += 1
        return row / max(np.linalg.norm(row), 1e-9)

    def __call__(self, texts, query=False, batch_size=16):
        with self.lock:
            self.calls += len(texts)
        return np.array([self.vector(t) for t in texts], dtype=np.float32).reshape(len(texts), kb.DIM)


class BlockingEmbedder(HashEmbedder):
    """Blocks inside the embedding call (query or passages, as chosen) until released."""

    def __init__(self):
        super().__init__()
        self.block_query = self.block_passages = False
        self.entered, self.release = threading.Event(), threading.Event()

    def __call__(self, texts, query=False, batch_size=16):
        if (query and self.block_query) or (not query and self.block_passages):
            self.entered.set()
            assert self.release.wait(10)
        return super().__call__(texts, query, batch_size)


FILLER = " Ordinary words about measurements, samples and the methods used in the laboratory." * 3


def doc(path: str, words: str, title: str | None = None) -> Document:
    return Document(path=path, title=title or path, text=f"# {title or path}\n\n{words}.{FILLER}")


def index_dir(root: Path, user: str) -> Path:
    return root / user / "knowledgebase" / "zotero" / "index"


@pytest.fixture
def isolated_kb(tmp_path, monkeypatch):
    """kb's own index and data folder point at tmp/global, which must stay untouched."""
    monkeypatch.setattr(kb, "HOME", tmp_path / "global")
    monkeypatch.setattr(kb, "DB_PATH", tmp_path / "global" / "data" / "kb.sqlite")
    return tmp_path


@pytest.fixture
def open_kb(isolated_kb):
    opened = []

    def make(user: str = "alice", embedder=None, **kw) -> KnowledgeBase:
        instance = KnowledgeBase(index_dir(isolated_kb, user) / "kb.sqlite", embedder=embedder or HashEmbedder(), **kw)
        opened.append(instance)
        return instance

    yield make
    for instance in opened:
        instance.close()


def paths(results) -> set[str]:
    return {r["path"] for r in results}


def count(db_path: Path, sql: str) -> int:
    db = sqlite3.connect(db_path)
    try:
        return db.execute(sql).fetchone()[0]
    finally:
        db.close()


def in_thread(target, *args):
    box: dict = {}

    def run():
        try:
            box["result"] = target(*args)
        except BaseException as error:  # noqa: BLE001
            box["error"] = error

    thread = threading.Thread(target=run)
    thread.start()
    return thread, box


# ---------------------------------------------------------------- isolation

def test_two_instances_are_isolated(open_kb):
    a, b = open_kb("alice"), open_kb("bob")
    assert a.apply(add=[doc("zotero/AAAA1111", "Quasiparticle energies from the GW approximation")]) == \
        {"added": 1, "removed": 0}
    assert b.search("quasiparticle") == []
    assert paths(a.search("quasiparticle")) == {"zotero/AAAA1111"}
    assert a.embed_pending() > 0
    assert a.stats()["chunks_with_vectors"] > 0
    assert b.stats()["chunks_with_vectors"] == 0 and b.stats()["notes"] == 0
    probe = "Quasiparticle energies from the GW approximation, measured in the laboratory samples."
    assert b.similar_to_text(probe) == []
    assert paths(a.similar_to_text(probe)) == {"zotero/AAAA1111"}


def test_instances_touch_only_their_own_files(open_kb, isolated_kb):
    a, b = open_kb("alice"), open_kb("bob")
    a.apply(add=[doc("zotero/A", "Excitons in quantum dots")])
    b.apply(add=[doc("zotero/B", "Phonons in graphene")])
    a.embed_pending(), b.embed_pending()
    a.search("excitons"), b.search("phonons")
    files = [p for p in isolated_kb.rglob("*") if p.is_file()]
    assert files
    for f in files:
        assert index_dir(isolated_kb, "alice") in f.parents or index_dir(isolated_kb, "bob") in f.parents, f
    assert (index_dir(isolated_kb, "alice") / "tantivy" / "meta.json").exists()
    assert (index_dir(isolated_kb, "bob") / "tantivy" / "meta.json").exists()
    assert not (isolated_kb / "global").exists()
    assert kb.DB_PATH == isolated_kb / "global" / "data" / "kb.sqlite"


def test_concurrent_tenants(open_kb):
    tenants = {"alice": open_kb("alice"), "bob": open_kb("bob")}
    seen: dict[str, set[str]] = {name: set() for name in tenants}

    def work(name: str):
        instance = tenants[name]
        for batch in range(5):
            instance.apply(add=[doc(f"zotero/{name}{batch}x{i}", f"shared topic {name} item {batch} {i}")
                                for i in range(10)], meta={"owner": name, f"batch_{name}": str(batch)})
            instance.embed_pending()
            for _ in range(4):
                seen[name] |= paths(instance.search("shared topic", limit=50))
                seen[name] |= paths(instance.similar_to_text(f"shared topic {name} item, measured in the laboratory"))

    threads = [in_thread(work, name) for name in tenants]
    for thread, box in threads:
        thread.join(60)
        assert "error" not in box, box.get("error")
    for name, instance in tenants.items():
        docs = instance.documents()
        assert len(docs) == 50 and all(p.startswith(f"zotero/{name}") for p in docs)
        assert instance.get_meta("owner") == name and instance.get_meta(f"batch_{name}") == "4"
        other = "bob" if name == "alice" else "alice"
        assert instance.get_meta(f"batch_{other}") is None
        assert seen[name] and all(p.startswith(f"zotero/{name}") for p in seen[name])
        assert instance.stats()["chunks_with_vectors"] == instance.stats()["chunks"]


# ---------------------------------------------------------------- atomicity

def _failing_store_note(monkeypatch, fail_on: int):
    real, calls = kb.store_note, []

    def store_note(*args, **kwargs):
        calls.append(args[1])
        if len(calls) == fail_on:
            raise RuntimeError("disk on fire")
        return real(*args, **kwargs)

    monkeypatch.setattr(kb, "store_note", store_note)
    return lambda: monkeypatch.setattr(kb, "store_note", real)


def test_apply_is_all_or_nothing(open_kb, monkeypatch):
    a = open_kb()
    restore = _failing_store_note(monkeypatch, fail_on=2)
    with pytest.raises(RuntimeError, match="disk on fire"):
        a.apply(add=[doc("zotero/1", "first xenon"), doc("zotero/2", "second xenon"), doc("zotero/3", "third xenon")],
                meta={"zotero_web_version:lib": "41"})
    restore()
    db_path = a.db_path
    for table in ("notes", "chunks", "vecs", "links"):
        assert count(db_path, f"SELECT count(*) FROM {table}") == 0, table
    assert count(db_path, "SELECT count(*) FROM chunks_fts WHERE chunks_fts MATCH 'xenon'") == 0
    assert a.get_meta("zotero_web_version:lib") is None and a.get_meta("indexed_at") is None
    assert a.search("xenon") == []
    a.apply(add=[doc("zotero/4", "fourth yttrium")], meta={"zotero_web_version:lib": "42"})
    assert set(a.documents()) == {"zotero/4"} and a.get_meta("zotero_web_version:lib") == "42"
    assert paths(a.search("yttrium")) == {"zotero/4"}


def test_apply_rolls_back_removals_too(open_kb, monkeypatch):
    a = open_kb()
    a.apply(add=[doc("zotero/P", "persistent xenon")])
    a.embed_pending()
    restore = _failing_store_note(monkeypatch, fail_on=1)
    with pytest.raises(RuntimeError):
        a.apply(remove=["zotero/P"], add=[doc("zotero/Q", "quick yttrium")])
    restore()
    assert set(a.documents()) == {"zotero/P"}
    assert a.stats()["chunks_with_vectors"] == a.stats()["chunks"] > 0
    assert paths(a.search("persistent xenon")) == {"zotero/P"}


def test_reapply_reuses_vectors(open_kb):
    embedder = HashEmbedder()
    a = open_kb(embedder=embedder)
    a.apply(add=[doc("uploads/a.md", "Band gaps of oxides", title="Oxides")])
    assert a.embed_pending() > 0
    calls = embedder.calls
    assert a.apply(remove=["uploads/a.md"], add=[doc("uploads/b.md", "Band gaps of oxides", title="Oxides")]) == \
        {"added": 1, "removed": 1}
    assert a.embed_pending() == 0 and embedder.calls == calls
    assert a.stats()["chunks_with_vectors"] == a.stats()["chunks"]


def test_remove_and_add_helpers(open_kb):
    a = open_kb()
    assert a.add_documents([doc("zotero/1", "one"), doc("zotero/2", "two")]) == 2
    assert a.remove_document("zotero/1") is True
    assert a.remove_document("zotero/1") is False
    assert set(a.documents()) == {"zotero/2"}


# ---------------------------------------------------------------- lifecycle

def test_failed_constructor_releases_claim(isolated_kb, monkeypatch):
    real = kb.Searcher

    def broken(*a, **k):
        raise OSError("no tantivy today")

    monkeypatch.setattr(kb, "Searcher", broken)
    db_path = index_dir(isolated_kb, "alice") / "kb.sqlite"
    with pytest.raises(OSError):
        KnowledgeBase(db_path, embedder=HashEmbedder())
    monkeypatch.setattr(kb, "Searcher", real)
    KnowledgeBase(db_path, embedder=HashEmbedder()).close()


def test_same_files_twice_refused(isolated_kb):
    db_path = index_dir(isolated_kb, "alice") / "kb.sqlite"
    first = KnowledgeBase(db_path, embedder=HashEmbedder())
    with pytest.raises(RuntimeError, match="already open"):
        KnowledgeBase(db_path.parent / "." / "kb.sqlite", embedder=HashEmbedder())
    with pytest.raises(RuntimeError, match="already open"):  # another database, the same keyword folder
        KnowledgeBase(db_path.parent / "other.sqlite", keyword_dir=db_path.parent / "tantivy", embedder=HashEmbedder())
    first.close()
    KnowledgeBase(db_path, embedder=HashEmbedder()).close()


def test_close_is_idempotent_and_waits(open_kb, monkeypatch):
    a = open_kb()
    a.apply(add=[doc("zotero/1", "first xenon")])
    a.embed_pending()
    a.search("xenon")
    # a background rebuild that blocks after reading the index
    rebuild_read, rebuild_release = threading.Event(), threading.Event()
    real_load = kb.Searcher._load
    searcher = a._searcher

    def load(this, full):
        real_load(this, full)
        if this is not searcher:
            rebuild_read.set()
            rebuild_release.wait(10)

    monkeypatch.setattr(kb.Searcher, "_load", load)
    searcher._start_rebuild()
    assert rebuild_read.wait(5)
    # an apply that blocks inside store_note
    in_store, store_release = threading.Event(), threading.Event()
    real_store = kb.store_note

    def store_note(*args, **kwargs):
        in_store.set()
        store_release.wait(10)
        return real_store(*args, **kwargs)

    monkeypatch.setattr(kb, "store_note", store_note)
    writer, write_box = in_thread(a.apply, [doc("zotero/2", "second yttrium")])
    assert in_store.wait(5)
    closer, close_box = in_thread(a.close)
    time.sleep(0.2)
    assert closer.is_alive()
    store_release.set()
    writer.join(5)
    time.sleep(0.1)
    assert closer.is_alive()  # the rebuild still runs
    rebuild_release.set()
    closer.join(5)
    assert not closer.is_alive() and "error" not in close_box and write_box.get("result") == {"added": 1, "removed": 0}
    assert not searcher._rebuild_thread.is_alive()
    a.close()  # idempotent
    for call in (lambda: a.search("xenon"), lambda: a.apply(add=[doc("zotero/3", "x")]), a.embed_pending, a.stats,
                 a.documents, lambda: a.get_meta("indexed_at"), lambda: a.read("zotero/1"),
                 lambda: a.similar_to_text("x" * 50)):
        with pytest.raises(ClosedError):
            call()
    monkeypatch.setattr(kb, "store_note", real_store)
    again = KnowledgeBase(a.db_path, embedder=HashEmbedder())
    try:
        assert set(again.documents()) == {"zotero/1", "zotero/2"}
        assert paths(again.search("yttrium")) == {"zotero/2"}
    finally:
        again.close()


# ---------------------------------------------------------------- concurrency contract (driver: searches wait)

def _blocked_search(instance: KnowledgeBase, embedder: BlockingEmbedder, query: str):
    embedder.block_query = True
    thread, box = in_thread(instance.search, query)
    assert embedder.entered.wait(5)
    return thread, box


def test_concurrent_search_on_one_instance_waits(open_kb):
    embedder = BlockingEmbedder()
    a = open_kb(embedder=embedder)
    a.apply(add=[doc("zotero/1", "xenon lamps"), doc("zotero/2", "yttrium garnets")])
    a.embed_pending()
    first, first_box = _blocked_search(a, embedder, "xenon lamps")
    second, second_box = in_thread(a.search, "yttrium garnets")
    time.sleep(0.3)
    assert second.is_alive()  # waits for the first search, does not fail
    embedder.release.set()
    first.join(5), second.join(5)
    assert paths(first_box["result"]) >= {"zotero/1"}
    assert paths(second_box["result"]) >= {"zotero/2"}


def test_search_wait_is_bounded(open_kb):
    embedder = BlockingEmbedder()
    a = open_kb(embedder=embedder, search_timeout=0.3)
    a.apply(add=[doc("zotero/1", "xenon lamps")])
    a.embed_pending()
    first, _ = _blocked_search(a, embedder, "xenon lamps")
    started = time.monotonic()
    with pytest.raises(ConcurrentUseError, match="another search"):
        a.search("anything else")
    assert 0.25 < time.monotonic() - started < 2
    assert isinstance(ConcurrentUseError("x"), TimeoutError)
    embedder.release.set()
    first.join(5)
    assert paths(a.search("xenon")) == {"zotero/1"}  # usable again


def test_instances_never_share_a_search_lock(open_kb):
    embedder = BlockingEmbedder()
    a, b = open_kb("alice", embedder=embedder, search_timeout=5), open_kb("bob", search_timeout=0.2)
    a.apply(add=[doc("zotero/1", "xenon lamps")])
    a.embed_pending()
    b.apply(add=[doc("zotero/2", "yttrium garnets")])
    b.embed_pending()
    first, _ = _blocked_search(a, embedder, "xenon lamps")
    assert paths(b.search("yttrium")) == {"zotero/2"}  # would time out if it shared A's lock
    embedder.release.set()
    first.join(5)


def test_search_during_write_is_consistent(open_kb):
    a = open_kb()
    old = {f"zotero/old{i}" for i in range(20)}
    new = {f"zotero/new{i}" for i in range(20)}
    a.apply(add=[doc(p, f"common keyword old item {i}") for i, p in enumerate(sorted(old))])
    a.embed_pending()
    stop, snapshots, errors = threading.Event(), [], []

    def searching():
        try:
            while not stop.is_set():
                snapshots.append(paths(a.search("common keyword", limit=50)))
                a._searcher.changed()  # look at the index on every call, not once a minute
        except BaseException as error:  # noqa: BLE001
            errors.append(error)

    thread = threading.Thread(target=searching)
    thread.start()
    for _ in range(3):
        a.apply(remove=sorted(old), add=[doc(p, f"common keyword new item {i}") for i, p in enumerate(sorted(new))])
        a.embed_pending()
        a.apply(remove=sorted(new), add=[doc(p, f"common keyword old item {i}") for i, p in enumerate(sorted(old))])
        a.embed_pending()
    time.sleep(0.2)
    stop.set()
    thread.join(10)
    assert not errors and snapshots
    for snapshot in snapshots:
        assert snapshot <= old or snapshot <= new, snapshot  # never half a batch
    assert paths(a.search("common keyword", limit=50)) == old


def test_embed_pending_serialised_with_apply(open_kb):
    embedder = BlockingEmbedder()
    a = open_kb(embedder=embedder)
    a.apply(add=[doc("zotero/keep", "kept item"), doc("zotero/X", "xenon item")])
    embedder.block_passages = True
    embedding, embed_box = in_thread(a.embed_pending)
    assert embedder.entered.wait(5)
    writer, write_box = in_thread(a.apply, [doc("zotero/Y", "yttrium replacement item")], ["zotero/X"])
    time.sleep(0.3)
    assert writer.is_alive()  # waits for the embedding batch to be written
    assert "zotero/Y" not in a.documents()
    embedder.block_passages = False
    embedder.release.set()
    embedding.join(5), writer.join(5)
    assert "error" not in embed_box and write_box.get("result") == {"added": 1, "removed": 1}
    a.embed_pending()
    db = sqlite3.connect(a.db_path)
    rows = db.execute("SELECT v.vec, v.path, c.path, n.title, c.heading, c.text FROM vecs v JOIN chunks c ON c.id=v.id "
                      "JOIN notes n ON n.path=c.path").fetchall()
    db.close()
    assert rows and len(rows) == a.stats()["chunks"]
    for vec, vec_path, chunk_path, title, heading, text in rows:
        assert vec_path == chunk_path
        expected = embedder.vector(kb._embed_text(title, heading, text)).astype(np.float16)
        assert np.array_equal(np.frombuffer(vec, dtype=np.float16), expected)


# ---------------------------------------------------------------- compatibility and import

def test_on_disk_format_is_veritas(isolated_kb, monkeypatch):
    home = isolated_kb / "legacy"
    made = KnowledgeBase(home / "data" / "kb.sqlite", embedder=HashEmbedder())  # tantivy: data/tantivy, as kb's
    made.apply(add=[doc("zotero/ABCD1234", "Spin waves in magnetic garnets")])
    made.embed_pending()
    made.close()
    monkeypatch.setattr(kb, "HOME", home)
    monkeypatch.setattr(kb, "DB_PATH", home / "data" / "kb.sqlite")
    monkeypatch.delenv("VERITAS_DATA", raising=False)
    legacy = kb.Searcher(writer=True)
    legacy.embed = HashEmbedder()
    try:
        assert paths(legacy.search("spin waves")) == {"zotero/ABCD1234"}
    finally:
        legacy.close()
    fresh = kb.connect(keep=True, path=isolated_kb / "fresh" / "kb.sqlite")

    def schema(db):
        return sorted(r for r in db.execute("SELECT type, name, sql FROM sqlite_master"))

    made_db = sqlite3.connect(home / "data" / "kb.sqlite")
    try:
        assert schema(made_db) == schema(fresh)
    finally:
        made_db.close()
        fresh.close()


def test_import_never_listens(tmp_path):
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    script = (
        "import socket, sys\n"
        f"sys.path.insert(0, {str(SERVER)!r})\n"
        f"sys.argv = ['host', 'serve', '--port', '{port}']\n"
        "import veritas_kb, kb\n"
        "assert sys.argv == ['host', 'serve', '--port', '%d']\n"
        "s = socket.socket(); s.bind(('127.0.0.1', %d)); s.close()\n"
        "print('free')\n" % (port, port))
    env = {**os.environ, "KB_SOURCES": str(tmp_path / "sources.json"), "KB_ZOTERO": str(tmp_path / "Zotero"),
           "KB_DB": str(tmp_path / "kb.sqlite"), "KB_PORT": str(port)}
    out = subprocess.run([sys.executable, "-c", script], cwd=tmp_path, env=env, capture_output=True, text=True,
                         timeout=60)
    assert out.returncode == 0, out.stderr
    assert out.stdout.strip() == "free"


def test_read_and_documents(open_kb):
    a = open_kb()
    text = "# Paper\n\n## Abstract\n\n" + "Spin waves. " * 200 + "\n\n## Methods\n\n" + "Brillouin scattering. " * 200
    a.apply(add=[Document(path="zotero/K1", title="Paper", text=text, version=123.0,
                          meta={"doi": "10.1/x", "year": 2020})])
    page = a.read("zotero/K1", max_chars=500)
    assert page["path"] == "zotero/K1" and page["title"] == "Paper" and page["zotero"]["doi"] == "10.1/x"
    assert page["truncated"] and page["next_offset"] == 500 and len(page["text"]) == 500
    assert page["text"].startswith("## Paper > Abstract")  # heading paths, as kb.read_note shows them
    rest = a.read("zotero/K1", max_chars=10**6, offset=page["next_offset"])
    assert not rest["truncated"] and "## Paper > Methods" in rest["text"]
    assert a.read("zotero/K1", heading="methods")["text"].startswith("## Paper > Methods")
    assert a.read("zotero/missing")["chars"] == 0
    assert a.documents() == {"zotero/K1": (123.0, len(text))}


def test_default_embedder_is_shared_per_model(isolated_kb, monkeypatch):
    built = []

    class Fake(HashEmbedder):
        def __init__(self, model_dir=None, backend=None):
            super().__init__()
            built.append((model_dir, backend))

    monkeypatch.setattr(kb, "Embedder", Fake)
    monkeypatch.setattr(kb, "_EMBEDDERS", {})
    model = isolated_kb / "models" / "arctic"
    model.mkdir(parents=True)
    a = KnowledgeBase(index_dir(isolated_kb, "alice") / "kb.sqlite", model)
    b = KnowledgeBase(index_dir(isolated_kb, "bob") / "kb.sqlite", model)
    try:
        assert a.embedder is b.embedder
        assert built == [(model.resolve(), "onnx" if sys.platform != "darwin" else "mlx")]
    finally:
        a.close()
        b.close()


def test_module_exports():
    assert set(veritas_kb.__all__) >= {"KnowledgeBase", "Document", "ConcurrentUseError", "ClosedError"}
