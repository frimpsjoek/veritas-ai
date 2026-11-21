"""veritas_kb.KnowledgeBase (spec 035): several independent indexes in one process. Paths follow the tenant layout
<user>/knowledgebase/zotero/index/{kb.sqlite,tantivy}. Embedders are fakes; no model is loaded."""
from __future__ import annotations

import json
import os
import re
import shutil
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


class FailsOnSecondBatch(HashEmbedder):
    """Embeds the first batch of passages, raises on the second; queries always work."""

    def __init__(self):
        super().__init__()
        self.batches = 0

    def __call__(self, texts, query=False, batch_size=16):
        if not query:
            self.batches += 1
            if self.batches == 2:
                raise RuntimeError("embedder died on batch 2")
        return super().__call__(texts, query, batch_size)


def test_failed_embed_pending_leaves_earlier_batches_searchable(open_kb):
    """Review r4: batch 1 is committed before batch 2 raises; a searcher refreshed before the run must see it."""
    a = open_kb(embedder=FailsOnSecondBatch())
    a.apply(add=[doc("zotero/AAAA1111", "Quasiparticle energies from the GW approximation"),
                 doc("zotero/BBBB2222", "Superconducting xenon lamps in cryogenic chambers")])
    probes = {"zotero/AAAA1111": "Quasiparticle energies from the GW approximation, measured in the laboratory.",
              "zotero/BBBB2222": "Superconducting xenon lamps in cryogenic chambers, measured in the laboratory."}
    assert a.similar_to_text(probes["zotero/AAAA1111"]) == []  # the searcher has loaded: no vectors yet
    with pytest.raises(RuntimeError, match="batch 2"):
        a.embed_pending(batch=1)
    embedded = {r[0] for r in sqlite3.connect(a.db_path).execute("SELECT DISTINCT path FROM vecs")}
    assert len(embedded) == 1
    (path,) = embedded
    assert path in paths(a.similar_to_text(probes[path]))


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


def test_keyword_dir_holding_the_database_refused(isolated_kb):
    """Review (files mode): a keyword folder that contains the database would be cleared, database and all, by the
    first keyword rebuild."""
    db_path = index_dir(isolated_kb, "alice") / "kb.sqlite"
    KnowledgeBase(db_path, embedder=HashEmbedder()).close()
    before = db_path.read_bytes()
    for keyword_dir in (db_path.parent, db_path.parent.parent, db_path, db_path / "tantivy",
                        db_path.parent / ".." / "index"):
        with pytest.raises(ValueError, match="keyword_dir"):
            KnowledgeBase(db_path, keyword_dir=keyword_dir, embedder=HashEmbedder())
    assert db_path.read_bytes() == before
    KnowledgeBase(db_path, embedder=HashEmbedder()).close()  # nothing left claimed


def test_keyword_dir_overlapping_another_instance_refused(isolated_kb):
    alice = index_dir(isolated_kb, "alice") / "kb.sqlite"
    first = KnowledgeBase(alice, embedder=HashEmbedder())
    first.apply(add=[doc("zotero/A", "Excitons in quantum dots")])
    try:
        bob = index_dir(isolated_kb, "bob") / "kb.sqlite"
        for keyword_dir in (isolated_kb / "alice", alice.parent.parent, alice.parent / "tantivy" / "sub"):
            with pytest.raises(ValueError, match="overlaps"):
                KnowledgeBase(bob, keyword_dir=keyword_dir, embedder=HashEmbedder())
        with pytest.raises(ValueError, match="overlaps"):  # a database inside another instance's keyword folder
            KnowledgeBase(alice.parent / "tantivy" / "kb.sqlite", keyword_dir=isolated_kb / "elsewhere",
                          embedder=HashEmbedder())
        KnowledgeBase(bob, embedder=HashEmbedder()).close()  # the refusals claimed nothing
        assert paths(first.search("excitons")) == {"zotero/A"}
    finally:
        first.close()


def test_rebuild_refuses_a_folder_with_foreign_files(open_kb, isolated_kb):
    """The keyword folder is cleared before a rebuild only when it holds nothing but Tantivy's and the index's files."""
    keyword_dir = isolated_kb / "shared"
    keyword_dir.mkdir()
    (keyword_dir / "thesis.docx").write_text("four years of work")
    a = open_kb(keyword_dir=keyword_dir)
    a.apply(add=[doc("zotero/A", "Excitons in quantum dots")])
    with pytest.raises(RuntimeError, match="not a keyword index"):
        a.search("excitons")
    assert (keyword_dir / "thesis.docx").read_text() == "four years of work"
    nested = isolated_kb / "nested"
    (nested / "other-tenant").mkdir(parents=True)
    (nested / "other-tenant" / "kb.sqlite").write_text("x")
    b = open_kb("bob", keyword_dir=nested)
    b.apply(add=[doc("zotero/B", "Phonons in graphene")])
    with pytest.raises(RuntimeError, match="not a keyword index"):
        b.search("phonons")
    assert (nested / "other-tenant" / "kb.sqlite").read_text() == "x"


@pytest.mark.parametrize("files", [
    {"meta.json": b"an unrelated application's metadata\n"},
    {"schema-version": b"2\n"},
    {"meta.json": b"an unrelated application's metadata\n", "schema-version": b"2\n"},
])
def test_rebuild_refuses_unmarked_lookalike_files(open_kb, isolated_kb, files):
    """Review r7: these names alone do not authenticate an index; every byte must survive a refused rebuild."""
    import keyword_index

    keyword_dir = isolated_kb / "unrelated"
    keyword_dir.mkdir()
    for name, content in files.items():
        (keyword_dir / name).write_bytes(content)
    before = _folder_state(keyword_dir)
    a = open_kb(keyword_dir=keyword_dir)
    a.apply(add=[doc("zotero/A", "Excitons in quantum dots")])
    with pytest.raises(keyword_index.NotAKeywordIndexError, match="not a keyword index"):
        a.search("excitons")
    assert _folder_state(keyword_dir) == before


def test_rebuild_refuses_unmarked_tantivy_with_another_schema(open_kb, isolated_kb):
    """Review r7: even a real Tantivy index is not a legacy keyword index when its records have another layout."""
    import keyword_index
    import tantivy

    keyword_dir = isolated_kb / "another-tantivy-index"
    keyword_dir.mkdir()
    builder = tantivy.SchemaBuilder()
    builder.add_text_field("title", stored=True)
    tantivy.Index(builder.build(), path=str(keyword_dir))
    (keyword_dir / "schema-version").write_text(keyword_index.SCHEMA_VERSION)
    before = _folder_state(keyword_dir)
    a = open_kb(keyword_dir=keyword_dir)
    a.apply(add=[doc("zotero/A", "Excitons in quantum dots")])
    with pytest.raises(keyword_index.NotAKeywordIndexError, match="not a keyword index"):
        a.search("excitons")
    assert _folder_state(keyword_dir) == before


def test_rebuild_marks_the_folder_and_rebuilds_marked_or_legacy_ones(open_kb, isolated_kb):
    import keyword_index

    a = open_kb()
    a.apply(add=[doc("zotero/A", "Excitons in quantum dots")])
    assert paths(a.search("excitons")) == {"zotero/A"}
    keyword_dir = a.keyword_dir
    assert (keyword_dir / keyword_index.MARKER).is_file()
    a.close()
    for legacy in (False, True):  # an old schema forces a rebuild; a legacy folder (pre-marker) has no marker
        if legacy:
            (keyword_dir / keyword_index.MARKER).unlink()
        (keyword_dir / "schema-version").write_text("1")
        again = open_kb()
        assert paths(again.search("excitons")) == {"zotero/A"}
        assert (keyword_dir / "schema-version").read_text() == keyword_index.SCHEMA_VERSION
        assert (keyword_dir / keyword_index.MARKER).is_file()
        again.close()


def _folder_state(folder: Path) -> dict[str, bytes]:
    return {p.name: p.read_bytes() for p in sorted(folder.iterdir())}


def _db_uuid(db_path: Path) -> str:
    db = sqlite3.connect(db_path)
    try:
        return db.execute("SELECT value FROM meta WHERE key='db_uuid'").fetchone()[0]
    finally:
        db.close()


def _count_rebuilds(monkeypatch) -> list[Path]:
    import keyword_index

    calls, real = [], keyword_index.KeywordIndex._rebuild

    def spy(self, *args, **kwargs):
        calls.append(self.path)
        return real(self, *args, **kwargs)

    monkeypatch.setattr(keyword_index.KeywordIndex, "_rebuild", spy)
    return calls


def test_keyword_folder_of_another_database_refused(open_kb, isolated_kb):
    """Review r6: a keyword folder is bound to its database. Bob's database opened with Alice's folder would load her
    ids.npy, count his overlapping chunk ids as indexed and rank them with her words; it is refused, untouched."""
    import keyword_index

    a = open_kb()
    a.apply(add=[doc("zotero/A", "Xenon lamps glow brightly")])
    assert paths(a.search("xenon")) == {"zotero/A"}
    keyword_dir = a.keyword_dir
    assert _db_uuid(a.db_path) in (keyword_dir / keyword_index.MARKER).read_text()
    a.close()
    before = _folder_state(keyword_dir)
    bob = index_dir(isolated_kb, "bob") / "kb.sqlite"
    seed = KnowledgeBase(bob, embedder=HashEmbedder())  # bob's own database, chunk ids overlapping alice's
    seed.apply(add=[doc("zotero/B", "Yttrium garnets are hard")])
    seed.close()
    with pytest.raises(keyword_index.KeywordIndexBindingError, match="another database"):
        KnowledgeBase(bob, keyword_dir=keyword_dir, embedder=HashEmbedder())
    with pytest.raises(RuntimeError, match="another database"):  # a fresh database too
        KnowledgeBase(isolated_kb / "carol" / "kb.sqlite", keyword_dir=keyword_dir, embedder=HashEmbedder())
    assert _folder_state(keyword_dir) == before
    again = open_kb()  # the refusals claimed nothing, and alice's folder still serves her
    assert paths(again.search("xenon")) == {"zotero/A"}


def test_unbound_legacy_folder_rebuilt_once_and_bound(open_kb, monkeypatch):
    """A folder without a database identity (legacy marker, or none) is rebuilt from the database once and bound;
    a normal reopen loads it without rebuilding."""
    import keyword_index

    a = open_kb()
    a.apply(add=[doc("zotero/A", "Xenon lamps glow brightly")])
    assert paths(a.search("xenon")) == {"zotero/A"}
    keyword_dir, db_path = a.keyword_dir, a.db_path
    a.close()
    rebuilds = _count_rebuilds(monkeypatch)
    reopened = open_kb()
    assert paths(reopened.search("xenon")) == {"zotero/A"}
    assert rebuilds == []  # bound to this database: loaded as it is
    reopened.close()
    for legacy_marker in (True, False):  # the pre-binding marker text; no marker at all (legacy data/tantivy)
        if legacy_marker:
            (keyword_dir / keyword_index.MARKER).write_text(
                "Tantivy keyword index of a Veritas kb.sqlite; rebuilt from it when needed.\n")
        else:
            (keyword_dir / keyword_index.MARKER).unlink()
        legacy = open_kb()
        assert paths(legacy.search("xenon")) == {"zotero/A"}
        assert rebuilds == [keyword_dir]
        assert _db_uuid(db_path) in (keyword_dir / keyword_index.MARKER).read_text()
        legacy.close()
        rebuilds.clear()
        bound = open_kb()
        assert paths(bound.search("xenon")) == {"zotero/A"}
        assert rebuilds == []
        bound.close()


def test_module_default_folder_rebound_not_refused(open_kb, isolated_kb, monkeypatch):
    """The legacy server's own pair (kb.DB_PATH with data/tantivy) is rebuilt when the folder is bound to another
    database (an import replaced kb.sqlite but not tantivy/), as before: only a named keyword folder is refused."""
    import keyword_index

    a = open_kb()
    a.apply(add=[doc("zotero/A", "Xenon lamps glow brightly")])
    a.search("xenon")
    a.close()
    data = kb.data_dir()
    data.mkdir(parents=True, exist_ok=True)
    shutil.copy2(a.db_path, kb.DB_PATH)
    shutil.copytree(a.keyword_dir, data / "tantivy")
    db = sqlite3.connect(kb.DB_PATH)
    db.execute("UPDATE meta SET value='an-imported-database' WHERE key='db_uuid'")
    db.commit()
    db.close()
    rebuilds = _count_rebuilds(monkeypatch)
    searcher = kb.Searcher(writer=True)
    try:
        searcher.keywords.sync(searcher.db)
        assert rebuilds == [data / "tantivy"]
        assert "an-imported-database" in (data / "tantivy" / keyword_index.MARKER).read_text()
        assert searcher.keywords.search(["xenon"], 10)
        rebuilds.clear()
        searcher.keywords.sync(searcher.db)
        assert rebuilds == []
    finally:
        searcher.close()


def _identityless_database(db_path: Path, path: str, words: str) -> None:
    """A database made by kb.connect and store_note alone (as `kb index` does): it has no db_uuid until a writer
    opens it, and its chunk ids start at 1 like every other database's."""
    db = kb.connect(keep=True, path=db_path)
    try:
        kb.store_note(db, path, path, "", "zotero", [], [], 0.0, 0, "", None, f"# {path}\n\n{words}.{FILLER}")
        db.commit()
        assert db.execute("SELECT value FROM meta WHERE key='db_uuid'").fetchone() is None
    finally:
        db.close()


def _bound_keyword_folder(open_kb) -> Path:
    """Alice's keyword folder, bound to her database, whose chunk 1 is about xenon."""
    a = open_kb()
    a.apply(add=[doc("zotero/A", "Xenon lamps glow brightly")])
    assert paths(a.search("xenon")) == {"zotero/A"}
    a.close()
    return a.keyword_dir


def test_named_bound_folder_refused_for_a_database_without_identity(open_kb, isolated_kb):
    """Review r8: a database no writer has opened has no db_uuid. A read-only searcher naming another database's
    keyword folder would load it, and a word only in that database's chunk 1 would return this database's chunk 1. It
    is refused, untouched, read-only too."""
    import keyword_index

    keyword_dir = _bound_keyword_folder(open_kb)
    bob = isolated_kb / "bob" / "kb.sqlite"
    _identityless_database(bob, "zotero/B", "Yttrium garnets are hard")
    before = _folder_state(keyword_dir)
    for writer in (False, True):
        with pytest.raises(keyword_index.KeywordIndexBindingError, match="another database"):
            kb.Searcher(writer=writer, db_path=bob, keyword_dir=keyword_dir, embed_factory=HashEmbedder)
        assert _folder_state(keyword_dir) == before
        if not writer:  # a reader makes no identity (a writer does, then finds the folder bound to another)
            assert count(bob, "SELECT count(*) FROM meta WHERE key='db_uuid'") == 0


def test_default_bound_folder_unused_for_a_database_without_identity(open_kb, isolated_kb):
    """Review r8: the module's own pair (kb.DB_PATH with data/tantivy) is rebuilt, not refused, when the folder is
    bound to another database; a reader cannot rebuild, so it leaves the folder unloaded and searches SQLite FTS."""
    keyword_dir = _bound_keyword_folder(open_kb)
    _identityless_database(kb.DB_PATH, "zotero/B", "Yttrium garnets are hard")
    shutil.copytree(keyword_dir, kb.data_dir() / "tantivy")
    reader = kb.Searcher(embed_factory=HashEmbedder)
    try:
        assert not reader.keywords.usable()
        assert reader.search("xenon") == []
        assert paths(reader.search("yttrium")) == {"zotero/B"}
    finally:
        reader.close()


def test_writer_opened_database_reads_its_own_bound_folder(open_kb, isolated_kb):
    """The binding check refuses nothing it should not: once a writer has given a database its identity and bound its
    folder, a read-only searcher of that pair uses Tantivy."""
    _identityless_database(index_dir(isolated_kb, "alice") / "kb.sqlite", "zotero/B", "Yttrium garnets are hard")
    a = open_kb()
    assert paths(a.search("yttrium")) == {"zotero/B"}
    a.close()
    reader = kb.Searcher(db_path=a.db_path, keyword_dir=a.keyword_dir, embed_factory=HashEmbedder)
    try:
        assert reader.keywords.usable()
        assert paths(reader.search("yttrium")) == {"zotero/B"}
        assert reader.search("xenon") == []
    finally:
        reader.close()


def test_recognition_rule(tmp_path):
    """Only regular index files are allowed; an unmarked folder also needs a valid legacy Tantivy schema."""
    import keyword_index
    import tantivy
    from keyword_index import MARKER, owned_by_index

    def folder(name, *files, dirs=()):
        path = tmp_path / name
        path.mkdir()
        for f in files:
            (path / f).write_text("")
        for d in dirs:
            (path / d).mkdir()
        return path

    seg = "c4b7866d20e643d1932ff9ca3be03a58"
    tantivy_files = ("meta.json", ".managed.json", ".tantivy-meta.lock", ".tantivy-writer.lock", f"{seg}.idx",
                     f"{seg}.pos", f"{seg}.term", f"{seg}.store", f"{seg}.fast", f"{seg}.fieldnorm", f"{seg}.9.del")
    assert owned_by_index(tmp_path / "missing")
    assert owned_by_index(folder("empty"))
    legacy = folder("legacy")
    tantivy.Index(keyword_index._schema(), path=str(legacy))
    (legacy / "schema-version").write_text(keyword_index.SCHEMA_VERSION)
    assert owned_by_index(legacy)
    assert not owned_by_index(folder("lookalike", *tantivy_files, "schema-version", "ids.npy"))
    assert not owned_by_index(folder("legacy-no-schema", *tantivy_files))
    assert owned_by_index(folder("marked", MARKER, "ids.npy"))
    assert not owned_by_index(folder("unmarked-ids-only", "ids.npy"))
    assert not owned_by_index(folder("foreign", *tantivy_files, MARKER, "notes.md"))
    assert not owned_by_index(folder("db", *tantivy_files, MARKER, "kb.sqlite"))
    assert not owned_by_index(folder("subdir", *tantivy_files, MARKER, dirs=("index",)))
    link = folder("link", *tantivy_files, MARKER)
    (link / f"{seg}.term").unlink()
    (link / f"{seg}.term").symlink_to(tmp_path / "legacy" / "meta.json")
    assert not owned_by_index(link)
    (tmp_path / "plain-file").write_text("")
    assert not owned_by_index(tmp_path / "plain-file")


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


def _chunk_ids(db_path: Path, path: str) -> set[int]:
    db = sqlite3.connect(db_path)
    try:
        return {r[0] for r in db.execute("SELECT id FROM chunks WHERE path=?", (path,))}
    finally:
        db.close()


@pytest.mark.parametrize("method", ["search", "similar_to_text"])
def test_search_sees_one_version_across_a_write(open_kb, method):
    """Review M1: an apply that deletes and reinserts (SQLite handing the old chunk ids to the new text) must not commit
    between a search's vector refresh and its chunk-row read; else the search scores A's vectors and returns B."""
    a = open_kb()
    a.apply(add=[doc("zotero/A", "Xenon lamps glow brightly")])
    a.embed_pending()
    old_ids = _chunk_ids(a.db_path, "zotero/A")
    searcher, real_refresh = a._searcher, a._searcher._refresh
    refreshed, go = threading.Event(), threading.Event()

    def refresh():
        real_refresh()
        if not refreshed.is_set():  # the search under test: pause after loading the vectors
            refreshed.set()
            assert go.wait(10)

    searcher._refresh = refresh
    query = "xenon lamps glow brightly, measured in the laboratory samples"
    searching, search_box = in_thread(getattr(a, method), query)
    assert refreshed.wait(5)
    writer, write_box = in_thread(a.apply, [doc("zotero/B", "Yttrium garnets are hard")], ["zotero/A"])
    writer.join(0.5)
    write_went_first = not writer.is_alive()
    go.set()
    searching.join(10), writer.join(10)
    assert "error" not in write_box and write_box["result"] == {"added": 1, "removed": 1}
    assert _chunk_ids(a.db_path, "zotero/B") & old_ids  # the setup really reused ids
    assert "error" not in search_box, search_box.get("error")
    assert paths(search_box["result"]) == {"zotero/A"}  # never B, which shares no word with the query
    assert not write_went_first  # the write waited for the search


def test_search_waits_for_embedding_within_the_timeout(open_kb):
    embedder = BlockingEmbedder()
    a = open_kb(embedder=embedder, search_timeout=0.3)
    a.apply(add=[doc("zotero/1", "xenon lamps")])
    embedder.block_passages = True
    embedding, embed_box = in_thread(a.embed_pending)
    assert embedder.entered.wait(5)
    started = time.monotonic()
    with pytest.raises(ConcurrentUseError):
        a.search("xenon")
    assert 0.25 < time.monotonic() - started < 2
    embedder.block_passages = False
    embedder.release.set()
    embedding.join(5)
    assert "error" not in embed_box
    assert paths(a.search("xenon")) == {"zotero/1"}


def test_search_timeout_covers_both_locks(open_kb):
    """One deadline for the write lock and the search lock together, not search_timeout for each."""
    a = open_kb(search_timeout=0.6)
    a._search_lock.acquire()
    a._write_lock.acquire()
    releaser = threading.Timer(0.4, a._write_lock.release)  # a timeout per lock would wait 1.0 s in all
    releaser.start()
    try:
        started = time.monotonic()
        with pytest.raises(ConcurrentUseError):
            a.search("anything")
        assert 0.55 < time.monotonic() - started < 0.9
    finally:
        releaser.join()
        a._search_lock.release()
    assert a.search("anything") == []


def _paused_connect(monkeypatch, pauses: int):
    """veritas_kb's sqlite3.connect, the first `pauses` calls held until released (all of them inside together)."""
    real, lock, entered = sqlite3.connect, threading.Lock(), []
    inside, release = threading.Barrier(pauses + 1, timeout=5), threading.Event()

    def connect(*args, **kwargs):
        with lock:
            pause = len(entered) < pauses
            entered.append(1)
        if pause:
            inside.wait()  # every paused read is inside at once: reads do not wait for each other
            assert release.wait(10)
        return real(*args, **kwargs)

    monkeypatch.setattr(veritas_kb, "sqlite3", type("sqlite3", (), {"connect": staticmethod(connect)}))
    return inside, release


def test_close_waits_for_reads(open_kb, monkeypatch):
    a = open_kb()
    a.apply(add=[doc("zotero/1", "first xenon")])
    inside, release = _paused_connect(monkeypatch, pauses=2)
    readers = [in_thread(a.documents), in_thread(a.get_meta, "indexed_at")]
    inside.wait()  # both reads are past the open check, before connecting
    closer, close_box = in_thread(a.close)
    time.sleep(0.2)
    assert closer.is_alive()  # waits for the reads
    with pytest.raises(ClosedError):
        a.stats()  # a read begun after close began
    with pytest.raises(ClosedError):
        a.read("zotero/1")
    release.set()
    for thread, _ in readers:
        thread.join(5)
    closer.join(5)
    assert not closer.is_alive() and "error" not in close_box
    assert set(readers[0][1]["result"]) == {"zotero/1"} and readers[1][1]["result"]
    KnowledgeBase(a.db_path, embedder=HashEmbedder()).close()  # the files were released


def test_second_close_waits_for_the_first(open_kb):
    """Review round 3 minor: a close() called while another runs returns only once the files are released."""
    a = open_kb()
    a.apply(add=[doc("zotero/1", "first xenon")])
    searcher, real_close = a._searcher, a._searcher.close
    inside, release = threading.Event(), threading.Event()

    def slow_close():
        inside.set()
        assert release.wait(10)
        real_close()

    searcher.close = slow_close
    first, first_box = in_thread(a.close)
    assert inside.wait(5)
    second, second_box = in_thread(a.close)
    second.join(0.3)
    assert second.is_alive()  # waits for the first close to finish
    release.set()
    first.join(5), second.join(5)
    assert not first.is_alive() and not second.is_alive()
    assert "error" not in first_box and "error" not in second_box
    KnowledgeBase(a.db_path, embedder=HashEmbedder()).close()  # the files were released


def test_reused_ids_reindexed_after_reopen(open_kb):
    """Review round 3 M1: ids deleted by apply() reach the keyword index even when the instance closes before the next
    search; a reopened index must not keep the old text's words for an id SQLite handed to new text."""
    a = open_kb()
    a.apply(add=[doc("zotero/A", "Xenon lamps glow brightly")])
    assert paths(a.search("xenon")) == {"zotero/A"}  # the keyword index now holds A's ids
    old_ids = _chunk_ids(a.db_path, "zotero/A")
    a.apply(add=[doc("zotero/B", "Yttrium garnets are hard")], remove=["zotero/A"])
    assert _chunk_ids(a.db_path, "zotero/B") & old_ids  # the setup really reused ids
    a.close()  # before any search
    again = open_kb()
    assert paths(again.search("xenon")) == set()
    assert paths(again.search("yttrium")) == {"zotero/B"}
    assert count(again.db_path, "SELECT count(*) FROM keyword_dirty") == 0  # consumed after the Tantivy commit
    again.close()
    third = open_kb()
    assert paths(third.search("xenon")) == set() and paths(third.search("yttrium")) == {"zotero/B"}


def test_failed_keyword_sync_keeps_dirty_ids(open_kb, monkeypatch):
    """The pending ids are dropped only after a successful Tantivy commit."""
    a = open_kb()
    a.apply(add=[doc("zotero/A", "Xenon lamps glow brightly")])
    a.search("xenon")
    a.apply(add=[doc("zotero/B", "Yttrium garnets are hard")], remove=["zotero/A"])
    a.close()
    import keyword_index

    def fail(self, writer, db, ids):
        raise RuntimeError("disk full")

    real_add = keyword_index.KeywordIndex._add
    monkeypatch.setattr(keyword_index.KeywordIndex, "_add", fail)
    again = open_kb()
    with pytest.raises(RuntimeError):
        again.search("xenon")
    assert count(again.db_path, "SELECT count(*) FROM keyword_dirty") > 0
    again.close()
    monkeypatch.setattr(keyword_index.KeywordIndex, "_add", real_add)
    third = open_kb()
    assert paths(third.search("xenon")) == set() and paths(third.search("yttrium")) == {"zotero/B"}


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
        f"sys.argv = argv = ['host', 'serve', '--port', '{port}']\n"
        "swapped = []\n"  # review minor: not even for a moment (an audit hook sees every import)
        "sys.addaudithook(lambda event, args: swapped.append(args[0]) "
        "if event == 'import' and sys.argv is not argv else None)\n"
        "import veritas_kb, kb\n"
        "assert not swapped, swapped\n"
        "assert sys.argv is argv and sys.argv == ['host', 'serve', '--port', '%d']\n"
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


def test_read_sees_one_version_across_a_write(open_kb, monkeypatch):
    """Review round 3 M2: an apply() committed between read()'s chunk query and its note_info query must not mix the
    old text with the new title."""
    a = open_kb()
    a.apply(add=[doc("zotero/K1", "Xenon lamps glow brightly", title="Old title")])
    real_info, wrote = kb.note_info, []

    def note_info(db, rel):
        if not wrote:
            wrote.append(a.apply(add=[doc("zotero/K1", "Yttrium garnets are hard", title="New title")]))
        return real_info(db, rel)

    monkeypatch.setattr(kb, "note_info", note_info)
    page = a.read("zotero/K1")
    assert wrote == [{"added": 1, "removed": 0}]  # the write committed between the two queries
    assert page["title"] == "Old title" and "Xenon" in page["text"] and "Yttrium" not in page["text"]
    monkeypatch.setattr(kb, "note_info", real_info)
    page = a.read("zotero/K1")
    assert page["title"] == "New title" and "Yttrium" in page["text"]


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


# ---------------------------------------------------------------- the host's folder list (review round 2, M1)

# Fresh process: sources.resolved, the read of the host's folder list, records each call and fails as a blocked folder
# (a stuck permission prompt) would. Importing the library and using an index of its own must never ask for it.
BLOCKED_LAYOUT = r'''
import re, sys, zlib
from pathlib import Path
import numpy as np
sys.path.insert(0, sys.argv[1])
import sources
calls = []
def blocked(*args, **kwargs):
    calls.append("resolved")
    raise PermissionError("the folder list is blocked")
sources.resolved = blocked
import veritas_kb, kb
assert calls == [], calls
assert "LAYOUT" not in vars(kb) and "VAULT" not in vars(kb)

class Hash:
    mlx = None
    def __call__(self, texts, query=False, batch_size=16):
        out = np.zeros((len(texts), kb.DIM), dtype=np.float32)
        for row, text in zip(out, texts):
            for word in re.findall(r"[a-z]+", text.lower()):
                row[zlib.crc32(word.encode()) % kb.DIM] += 1
            row /= max(np.linalg.norm(row), 1e-9)
        return out

filler = " Ordinary words about measurements and samples." * 4
with veritas_kb.KnowledgeBase(Path(sys.argv[2]) / "kb.sqlite", embedder=Hash()) as index:
    index.apply(add=[veritas_kb.Document("zotero/K1", "Excitons", "# Excitons\n\nExcitons in quantum dots." + filler)])
    index.embed_pending()
    assert index.search("excitons quantum dots")[0]["path"] == "zotero/K1"
    assert index.similar_to_text("Excitons in quantum dots" + filler)[0]["path"] == "zotero/K1"
    assert "Excitons" in index.read("zotero/K1")["text"]
    assert list(index.documents()) == ["zotero/K1"]
    assert index.stats()["notes"] == 1 and "vault" not in index.stats()
assert calls == [], calls
print("ok")
'''


def test_library_never_reads_the_hosts_folder_list(tmp_path):
    env = {**os.environ, "KB_SOURCES": str(tmp_path / "sources.json"), "KB_DB": str(tmp_path / "global.sqlite")}
    out = subprocess.run([sys.executable, "-c", BLOCKED_LAYOUT, str(SERVER), str(tmp_path)], cwd=tmp_path, env=env,
                         capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stderr
    assert out.stdout.strip().splitlines()[-1] == "ok"
    assert not (tmp_path / "global.sqlite").exists()


# The CLI (kb.py, and the frozen server, which runs kb.main) still reads the folder list before it works.
CLI_LAYOUT = r'''
import json, sys
sys.path.insert(0, sys.argv[1])
import sources
calls = []
real = sources.resolved
def counted(*args, **kwargs):
    calls.append("resolved")
    return real(*args, **kwargs)
sources.resolved = counted
import kb
assert calls == [], calls
sys.argv = ["kb.py", "stats"]
kb.main()
assert calls == ["resolved"], calls
assert kb.VAULT == kb.LAYOUT.main
print(json.dumps({"calls": calls}))
'''


def test_cli_reads_the_folder_list(tmp_path):
    env = {**os.environ, "KB_SOURCES": str(tmp_path / "sources.json"), "KB_DB": str(tmp_path / "kb.sqlite"),
           "KB_ZOTERO": str(tmp_path / "Zotero")}
    out = subprocess.run([sys.executable, "-c", CLI_LAYOUT, str(SERVER)], cwd=tmp_path, env=env, capture_output=True,
                         text=True, timeout=120)
    assert out.returncode == 0, out.stderr
    assert '"calls": ["resolved"]' in out.stdout


def test_kb_script_still_loads_the_layout(tmp_path):
    vault = tmp_path / "Vault"
    (vault / ".obsidian").mkdir(parents=True)
    (tmp_path / "sources.json").write_text(
        '{"version": 1, "folders": [{"name": "vault", "path": "%s", "enabled": true, "skip": [], "main": true}]}'
        % vault.as_posix())
    env = {**os.environ, "KB_SOURCES": str(tmp_path / "sources.json"), "KB_DB": str(tmp_path / "kb.sqlite"),
           "KB_ZOTERO": str(tmp_path / "Zotero")}
    out = subprocess.run([sys.executable, str(SERVER / "kb.py"), "stats"], cwd=tmp_path, env=env, capture_output=True,
                         text=True, timeout=120)
    assert out.returncode == 0, out.stderr
    assert json.loads(out.stdout)["vault"] == str(vault)


def test_layout_loads_on_first_use(monkeypatch):
    """Modules that read kb.VAULT / kb.LAYOUT (web_app, radar_api, eval, ...) still get the folder list."""
    monkeypatch.delitem(vars(kb), "LAYOUT", raising=False)
    monkeypatch.delitem(vars(kb), "VAULT", raising=False)
    assert kb.VAULT == kb.LAYOUT.main
    monkeypatch.delitem(vars(kb), "LAYOUT")
    monkeypatch.delitem(vars(kb), "VAULT")
    assert kb.roots()[0].path == kb.LAYOUT.main  # kb's own functions too


def test_server_start_reads_the_folder_list(monkeypatch):
    import http_api
    import listen_first

    order = []

    class Started(Exception):
        pass

    monkeypatch.setattr(listen_first, "listen", lambda port: order.append("listen"))
    monkeypatch.setattr(kb, "ensure_layout", lambda: order.append("layout"))

    def token():
        order.append("token")
        raise Started

    monkeypatch.setattr(http_api, "token", token)
    with pytest.raises(Started):
        http_api.serve(0)
    assert order == ["listen", "layout", "token"]


# ---------------------------------------------------------------- T0-E: exact bounds and path-prefix visibility


@pytest.mark.parametrize("text", [
    "",
    "# Heading with no body\n\n## Another empty heading",
    "x" * (kb.CHUNK_CHARS * 4 + 37),
    "# Results\n\n" + "Sentence with a measured value. " * 300,
    "intro\n\n```sh\n# not a heading\n" + "print('x')\n" * 400 + "```",
])
def test_chunk_count_is_the_installed_chunkers_exact_count(open_kb, text):
    a = open_kb()
    document = Document("zotero/pathological", "Fallback title", text)
    expected = len(kb.chunk_note(text) or [kb.Chunk("", document.title)])
    assert a.count_chunks(document) == expected
    a.apply(add=[document])
    assert count(a.db_path, "SELECT count(*) FROM chunks WHERE path='zotero/pathological'") == expected
    assert expected >= 1


def test_bounded_embed_pending_drains_only_the_requested_chunks_and_refreshes_search(open_kb):
    a = open_kb()
    documents = [doc(f"zotero/pending-{i}", f"xenon pending item number {i}") for i in range(7)]
    a.apply(add=documents)
    probe = "xenon pending item number, measured in the laboratory samples."
    assert a.similar_to_text(probe) == []  # load the empty vector state before any batch commits
    assert a.embed_pending(batch=2, max_chunks=3) == 3
    assert a.stats()["chunks_with_vectors"] == 3
    assert a.similar_to_text(probe)  # committed bounded work is visible without a close/reopen
    assert a.embed_pending(batch=2, max_chunks=3) == 3
    assert a.stats()["chunks_with_vectors"] == 6
    assert a.embed_pending(batch=2, max_chunks=3) == 1
    assert a.stats()["chunks_with_vectors"] == a.stats()["chunks"] == 7
    assert a.embed_pending(batch=2, max_chunks=3) == 0
    assert a.embed_pending(max_chunks=0) == 0
    with pytest.raises(ValueError, match="max_chunks"):
        a.embed_pending(max_chunks=-1)
    with pytest.raises(ValueError, match="batch"):
        a.embed_pending(batch=0, max_chunks=2)
    with pytest.raises(ValueError, match="batch"):
        a.embed_pending(batch=-1, max_chunks=2)
    assert a.stats()["chunks_with_vectors"] == 7


def test_partial_embed_failure_preserves_committed_work_and_bounded_retry(open_kb):
    embedder = FailsOnSecondBatch()
    a = open_kb(embedder=embedder)
    a.apply(add=[doc(f"zotero/retry-{i}", f"quasiparticle retry item {i}") for i in range(6)])
    probe = "quasiparticle retry item, measured in the laboratory samples."
    assert a.similar_to_text(probe) == []
    with pytest.raises(RuntimeError, match="batch 2"):
        a.embed_pending(batch=2, max_chunks=6)
    assert a.stats()["chunks_with_vectors"] == 2
    assert embedder.batches == 2
    assert a.similar_to_text(probe)  # the batch committed before the failure has refreshed the searcher
    assert a.embed_pending(batch=1, max_chunks=2) == 2
    assert a.stats()["chunks_with_vectors"] == 4
    assert a.embed_pending(batch=2, max_chunks=2) == 2
    assert a.stats()["chunks_with_vectors"] == a.stats()["chunks"] == 6


class VisibilityEmbedder(HashEmbedder):
    """Marker vectors let vector-only queries use text that the keyword index cannot match."""

    mlx = None

    def __call__(self, texts, query=False, batch_size=16):
        with self.lock:
            self.calls += len(texts)
        out = np.zeros((len(texts), kb.DIM), dtype=np.float32)
        for row, text in zip(out, texts):
            for i, marker in enumerate(("alpha", "beta", "gamma", "delta")):
                if marker in text.lower():
                    row[i] = 1.0
            if not row.any():
                row[-1] = 1.0
            row /= np.linalg.norm(row)
        return out


def visible_doc(path: str, body: str, number: int) -> Document:
    return Document(path, f"Visible item {number}", f"# Visible item {number}\n\n{body} unique{number}", source="personal")


def test_keyword_visibility_is_before_the_candidate_limit_and_total(open_kb):
    a = open_kb(vector_gate=2.0)  # keyword only
    staged = [visible_doc(f"zotero/g/staged/item/{i}", "commonvisibility " * 20, i) for i in range(650)]
    active = [visible_doc(f"zotero/g/active/item/{i}",
                          f"activemarker{i} commonvisibility " + "unrelated padding " * 1500, 1000 + i) for i in range(3)]
    a.apply(add=staged + active)
    a._searcher._refresh()
    unfiltered = a._searcher.keywords.search(["commonvisibility"], 600)
    top_paths = dict(sqlite3.connect(a.db_path).execute("SELECT id, path FROM chunks"))
    assert not {top_paths[cid] for cid in unfiltered} & {d.path for d in active}  # a >600-candidate fixture

    found = a.search("commonvisibility", limit=2, allowed_path_prefixes=("zotero/g/active/",), include_total=True)
    assert found["total"] == 3
    assert len(found["results"]) == 2
    assert {hit["path"] for hit in found["results"]} <= {d.path for d in active}


def test_vector_visibility_is_before_the_candidate_limit_and_total(open_kb):
    embedder = VisibilityEmbedder()
    a = open_kb(embedder=embedder)
    staged = [visible_doc(f"zotero/g/staged/item/{i}", "zzalphazz ", i) for i in range(650)]
    active = [visible_doc(f"zotero/g/active/item/{i}", "zzalphazz zzbetazz ", 1000 + i) for i in range(3)]
    a.apply(add=staged + active)
    assert a.embed_pending(batch=256, max_chunks=700) == 653

    found = a.search("near alpha", limit=2, allowed_path_prefixes=("zotero/g/active/",), include_total=True)
    assert found["total"] == 3
    assert len(found["results"]) == 2
    assert {hit["path"] for hit in found["results"]} <= {d.path for d in active}
    # The bounded (600-candidate) pool too: 650 better-scoring staged vectors must be masked before selection.
    bounded = a.search("near alpha", limit=2, allowed_path_prefixes=("zotero/g/active/",))
    assert len(bounded) == 2 and paths(bounded) <= {d.path for d in active}


def test_generation_views_exclude_staged_and_never_mix_old_and_new(open_kb):
    a = open_kb(embedder=VisibilityEmbedder())
    old = [visible_doc(f"zotero/g/old/item/{i}", "generationtopic zzalphazz ", i) for i in range(4)]
    new = [visible_doc(f"zotero/g/new/item/{i}", "generationtopic zzalphazz ", 100 + i) for i in range(2)]
    unrelated = [visible_doc("zotero/g/unrelated/item/1", "generationtopic zzalphazz ", 500)]
    a.apply(add=old + new + unrelated)  # new and unrelated are physically present but inactive
    a.embed_pending()

    for query in ("generationtopic", "near alpha"):
        old_found = a.search(query, limit=20, allowed_path_prefixes=("zotero/g/old/",), include_total=True)
        assert old_found["total"] == 4
        assert paths(old_found["results"]) == {d.path for d in old}
        new_found = a.search(query, limit=20, allowed_path_prefixes=("zotero/g/new/",), include_total=True)
        assert new_found["total"] == 2
        assert paths(new_found["results"]) == {d.path for d in new}
        empty = a.search(query, allowed_path_prefixes=(), include_total=True)
        assert empty == {"results": [], "total": 0}
        assert isinstance(a.search(query, allowed_path_prefixes=("zotero/g/old/",)), list)


def force_sqlite_fts(a: KnowledgeBase) -> list[str]:
    """Make searches take the real SQLite FTS5 fallback; returns the MATCH strings it ran. Clearing keywords.index is
    not enough: the writer's next refresh rebuilds a missing Tantivy index before searching."""
    searcher, ran = a._searcher, []
    real = searcher._fts
    searcher.keywords.usable = lambda: False
    searcher._fts = lambda match, *rest: ran.append(match) or real(match, *rest)
    return ran


def test_visibility_also_applies_to_the_sqlite_fts_fallback(open_kb):
    a = open_kb(vector_gate=2.0)
    inactive = [visible_doc(f"zotero/g/inactive/item/{i}", "fallbacktopic " * 10, i) for i in range(10)]
    active = [visible_doc(f"zotero/g/active/item/{i}", "fallbacktopic ", 100 + i) for i in range(2)]
    a.apply(add=inactive + active)
    ran = force_sqlite_fts(a)
    found = a.search("fallbacktopic", limit=1, allowed_path_prefixes=("zotero/g/active/",), include_total=True)
    assert ran
    assert found["total"] == 2 and len(found["results"]) == 1
    assert paths(found["results"]) <= {d.path for d in active}


@pytest.mark.parametrize("sqlite_fallback", [False, True])
def test_path_prefixes_are_literal_for_tantivy_and_sqlite(open_kb, sqlite_fallback):
    a = open_kb(vector_gate=2.0)
    prefix = "zotero/g/a generation+[old]_100%/[item]/"
    a.apply(add=[visible_doc(prefix + "one", "literalprefix ", 1),
                 visible_doc("zotero/g/axgenerationXoldY100Z/item/two", "literalprefix ", 2)])
    ran = force_sqlite_fts(a) if sqlite_fallback else None
    found = a.search("literalprefix", allowed_path_prefixes=(prefix,), include_total=True)
    assert ran is None or ran
    assert set(found) == {"results", "total"} and found["total"] == 1
    assert paths(found["results"]) == {prefix + "one"}


def test_total_is_opt_in_and_empty_visibility_does_not_load_the_query_embedder(open_kb):
    embedder = VisibilityEmbedder()
    a = open_kb(embedder=embedder)
    a.apply(add=[visible_doc("zotero/g/active/item/1", "ordinarytopic zzalphazz ", 1)])
    assert isinstance(a.search("ordinarytopic"), list)
    found = a.search("ordinarytopic", allowed_path_prefixes=["zotero/g/active/"], include_total=True)
    assert found["total"] == 1 and paths(found["results"]) == {"zotero/g/active/item/1"}
    before = embedder.calls
    assert a.search("near alpha", allowed_path_prefixes=[], include_total=True) == {"results": [], "total": 0}
    assert embedder.calls == before
    with pytest.raises(ValueError, match="prefix"):
        a.search("ordinarytopic", allowed_path_prefixes=[""])


def test_large_replacement_searches_see_complete_visible_generations(open_kb):
    a = open_kb(vector_gate=2.0)
    old = {f"zotero/g/old/item/{i}" for i in range(25)}
    new = {f"zotero/g/new/item/{i}" for i in range(25)}
    a.apply(add=[visible_doc(p, "replacementtopic ", i) for i, p in enumerate(sorted(old))])
    stop, snapshots, errors = threading.Event(), [], []

    def searching():
        try:
            while not stop.is_set():
                for generation, wanted in (("old", old), ("new", new)):
                    found = a.search("replacementtopic", limit=50,
                                     allowed_path_prefixes=(f"zotero/g/{generation}/",), include_total=True)
                    snapshots.append((generation, found))
        except BaseException as error:  # noqa: BLE001
            errors.append(error)

    thread = threading.Thread(target=searching)
    thread.start()
    for _ in range(2):
        a.apply(remove=sorted(old), add=[visible_doc(p, "replacementtopic ", 1000 + i)
                                        for i, p in enumerate(sorted(new))])
        a.apply(remove=sorted(new), add=[visible_doc(p, "replacementtopic ", 2000 + i)
                                        for i, p in enumerate(sorted(old))])
    stop.set()
    thread.join(30)
    assert not errors and snapshots
    for generation, found in snapshots:
        wanted = old if generation == "old" else new
        assert found["total"] in (0, len(wanted)), (generation, found["total"])
        assert paths(found["results"]) in (set(), wanted)


@pytest.mark.parametrize("sqlite_fallback", [False, True])
def test_path_prefixes_are_case_sensitive_for_tantivy_and_sqlite(open_kb, sqlite_fallback):
    """Review L3E r1 M1: SQLite LIKE folds ASCII case; visibility is Python's case-sensitive startswith."""
    a = open_kb(vector_gate=2.0)
    a.apply(add=[visible_doc("zotero/g/active/item/1", "casetopic ", 1),
                 visible_doc("zotero/g/ACTIVE/item/2", "casetopic ", 2),
                 visible_doc("zotero/g/Active/item/3", "casetopic ", 3)])
    ran = force_sqlite_fts(a) if sqlite_fallback else None
    found = a.search("casetopic", allowed_path_prefixes=("zotero/g/active/",), include_total=True)
    assert ran is None or ran
    assert found["total"] == 1 and paths(found["results"]) == {"zotero/g/active/item/1"}
    upper = a.search("casetopic", allowed_path_prefixes=("zotero/g/ACTIVE/",), include_total=True)
    assert upper["total"] == 1 and paths(upper["results"]) == {"zotero/g/ACTIVE/item/2"}


def test_prefix_iterable_is_consumed_before_any_lock(open_kb):
    """Review L3E r2 M1: a lazy caller iterable is snapshotted before the search takes its locks."""
    a = open_kb(vector_gate=2.0)
    a.apply(add=[visible_doc("zotero/g/active/item/1", "locktopic ", 1)])
    held = []

    def manifest():
        for lock in (a._write_lock, a._search_lock):
            free = lock.acquire(blocking=False)
            held.append(not free)
            if free:
                lock.release()
        yield "zotero/g/active/"

    found = a.search("locktopic", allowed_path_prefixes=manifest(), include_total=True)
    assert held == [False, False]
    assert found["total"] == 1 and paths(found["results"]) == {"zotero/g/active/item/1"}


@pytest.mark.parametrize("sqlite_fallback", [False, True])
def test_path_prefix_suffix_may_contain_a_newline(open_kb, sqlite_fallback):
    """Review L3E r2 nit: Tantivy's regex `.` skipped newlines, so engines disagreed on a legal path."""
    a = open_kb(vector_gate=2.0)
    a.apply(add=[visible_doc("zotero/g/active/item\nline/1", "newlinetopic ", 1)])
    ran = force_sqlite_fts(a) if sqlite_fallback else None
    found = a.search("newlinetopic", allowed_path_prefixes=("zotero/g/active/",), include_total=True)
    assert ran is None or ran
    assert found["total"] == 1 and paths(found["results"]) == {"zotero/g/active/item\nline/1"}


def test_path_prefix_elements_must_be_strings(open_kb):
    """Review L3E r3 M1: Path("zotero/g/active/") is "zotero/g/active", which would admit "active-staged"."""
    a = open_kb(vector_gate=2.0)
    a.apply(add=[visible_doc("zotero/g/active-staged/item/1", "pathtypetopic ", 1)])
    for bad in ([Path("zotero/g/active/")], ["zotero/g/active/", Path("zotero/g/other/")], [b"zotero/g/active/"]):
        with pytest.raises(TypeError, match="must be a str"):
            a.search("pathtypetopic", allowed_path_prefixes=bad, include_total=True)
    found = a.search("pathtypetopic", allowed_path_prefixes=["zotero/g/active/"], include_total=True)
    assert found == {"results": [], "total": 0}


def test_sqlite_fallback_takes_more_prefixes_than_host_parameters(open_kb):
    """Review L3E r3 M2: two bound parameters per prefix overflowed SQLite's limit (32766), and _fts swallowed the
    OperationalError as "no keyword candidates"; the allow set is now one bound JSON array."""
    a = open_kb(vector_gate=2.0)
    a.apply(add=[visible_doc("zotero/g/active/item/1", "manyprefixtopic ", 1),
                 visible_doc("zotero/g/hidden/item/2", "manyprefixtopic ", 2)])
    ran = force_sqlite_fts(a)
    prefixes = [f"zotero/g/unused{i}/" for i in range(40_000)] + ["zotero/g/active/"]
    found = a.search("manyprefixtopic", allowed_path_prefixes=prefixes, include_total=True)
    assert ran
    assert found["total"] == 1 and paths(found["results"]) == {"zotero/g/active/item/1"}


def _v2_keyword_schema():
    """The keyword schema before L3E added the raw path term (SCHEMA_VERSION 2)."""
    import tantivy

    builder = tantivy.SchemaBuilder()
    builder.add_integer_field("id", stored=True, indexed=True, fast=True)
    builder.add_text_field("body", stored=False, tokenizer_name="en_stem")
    return builder.build()


def test_unmarked_v2_keyword_folder_is_rebuilt_as_the_current_schema(open_kb, monkeypatch):
    """Review L3E r1 M2: a real pre-marker data/tantivy written with the previous (v2) schema is this module's own
    folder; the schema bump must rebuild it, not refuse it as foreign."""
    import keyword_index
    import tantivy

    a = open_kb()
    a.apply(add=[doc("zotero/A", "Xenon lamps glow brightly")])
    assert paths(a.search("xenon")) == {"zotero/A"}
    keyword_dir = a.keyword_dir
    a.close()
    for entry in keyword_dir.iterdir():
        entry.unlink()
    legacy = tantivy.Index(_v2_keyword_schema(), path=str(keyword_dir))
    writer = legacy.writer()
    writer.add_document(tantivy.Document(id=1, body="Xenon lamps glow brightly"))
    writer.commit()
    writer.wait_merging_threads()
    (keyword_dir / "schema-version").write_text("2")
    np.save(keyword_dir / "ids.npy", np.array([1], dtype=np.int64))
    assert not (keyword_dir / keyword_index.MARKER).exists()
    assert keyword_index.owned_by_index(keyword_dir)
    rebuilds = _count_rebuilds(monkeypatch)
    again = open_kb()
    assert paths(again.search("xenon")) == {"zotero/A"}
    assert rebuilds == [keyword_dir]
    assert (keyword_dir / "schema-version").read_text() == keyword_index.SCHEMA_VERSION
    assert (keyword_dir / keyword_index.MARKER).is_file()
    assert tantivy.Index.open(str(keyword_dir)).schema == keyword_index._schema()
    found = again.search("xenon", allowed_path_prefixes=("zotero/",), include_total=True)
    assert found["total"] == 1  # the rebuilt index carries the path term


def test_path_filtered_vector_search_uses_in_memory_paths_and_stays_exact_across_reloads(open_kb):
    """Review L3E r1 M3: the vector-side visibility mask comes from paths loaded with the vectors, not a per-search
    read of every chunk row, and stays exact across incremental reloads, deletes and chunk-id reuse."""
    a = open_kb(embedder=VisibilityEmbedder())
    active = [visible_doc(f"zotero/g/active/item/{i}", "zzalphazz ", i) for i in range(3)]
    staged = [visible_doc(f"zotero/g/staged/item/{i}", "zzalphazz ", 100 + i) for i in range(5)]
    a.apply(add=active + staged)
    a.embed_pending()
    prefix = ("zotero/g/active/",)
    assert a.search("near alpha", limit=50, allowed_path_prefixes=prefix, include_total=True)["total"] == 3

    statements: list[str] = []
    a._searcher.db.set_trace_callback(statements.append)
    try:
        found = a.search("near alpha", limit=50, allowed_path_prefixes=prefix, include_total=True)
    finally:
        a._searcher.db.set_trace_callback(None)
    assert found["total"] == 3 and paths(found["results"]) == {d.path for d in active}
    unbounded = [s for s in statements if re.search(r"\bFROM\s+chunks\b", s) and "WHERE" not in s.upper()]
    assert unbounded == [], unbounded

    # Incremental reload: new visible and invisible chunks append to the loaded vectors.
    more = [visible_doc(f"zotero/g/active/item/{i}", "zzalphazz ", i) for i in range(3, 5)]
    a.apply(add=more + [visible_doc("zotero/g/staged/item/new", "zzalphazz ", 999)])
    a.embed_pending()
    found = a.search("near alpha", limit=50, allowed_path_prefixes=prefix, include_total=True)
    assert found["total"] == 5 and paths(found["results"]) == {d.path for d in active + more}

    # Deletes, then chunk-id reuse: the highest id (a visible chunk) is deleted and SQLite hands it to a staged one.
    top = count(a.db_path, "SELECT max(id) FROM chunks")
    top_path = sqlite3.connect(a.db_path).execute("SELECT path FROM chunks WHERE id=?", (top,)).fetchone()[0]
    assert top_path == "zotero/g/staged/item/new"
    a.apply(remove=["zotero/g/staged/item/new", more[-1].path])
    a.apply(add=[visible_doc("zotero/g/staged/item/reused", "zzalphazz ", 998)])
    a.embed_pending()
    assert sqlite3.connect(a.db_path).execute(
        "SELECT count(*) FROM chunks WHERE path='zotero/g/staged/item/reused' AND id<=?", (top,)).fetchone()[0]
    found = a.search("near alpha", limit=50, allowed_path_prefixes=prefix, include_total=True)
    assert found["total"] == 4 and paths(found["results"]) == {d.path for d in active + more[:-1]}
    staged_found = a.search("near alpha", limit=50, allowed_path_prefixes=("zotero/g/staged/",), include_total=True)
    assert staged_found["total"] == 6
    assert "zotero/g/staged/item/reused" in paths(staged_found["results"])


def test_stale_in_memory_vector_path_never_widens_visibility(open_kb):
    """Another process may delete a visible note and reuse its chunk id for an invisible one before this searcher
    reloads. The loaded vector still names the old path; the hit is checked against the row's current path."""
    a = open_kb(embedder=VisibilityEmbedder())
    a.apply(add=[visible_doc("zotero/g/active/item/1", "zzalphazz ", 1)])
    a.embed_pending()
    prefix = ("zotero/g/active/",)
    assert a.search("near alpha", allowed_path_prefixes=prefix, include_total=True)["total"] == 1
    other = sqlite3.connect(a.db_path)
    try:
        cid = other.execute("SELECT id FROM chunks WHERE path='zotero/g/active/item/1'").fetchone()[0]
        other.execute("INSERT INTO notes (path, title, source, tags, mtime, meta) "
                      "VALUES ('zotero/g/hidden/1', 'Hidden', 'personal', '', 0, NULL)")
        other.execute("UPDATE chunks SET path='zotero/g/hidden/1' WHERE id=?", (cid,))
        other.commit()
    finally:
        other.close()
    found = a.search("near alpha", allowed_path_prefixes=prefix, include_total=True)  # within the 60 s recheck window
    assert found == {"results": [], "total": 0}
