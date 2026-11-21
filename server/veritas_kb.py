"""The search index as a library: one KnowledgeBase per index, many in one process (spec 035).

Each instance owns one SQLite file, one Tantivy folder and one kb.Searcher, and never reads kb's per-index module
settings (DB_PATH, HOME, the folder list, the key store); only the embedding model is shared (kb.shared_embedder),
read-only. The on-disk format is kb's: a database written here is a Veritas database.

Calls are blocking: an async host runs them in worker threads. Thread-safety contract, per instance:
- writes (apply, embed_pending) take the write lock and queue behind each other;
- searches (search, similar_to_text) take the write lock, then the search lock, so a search sees one committed version
  of the index (vectors, keyword index and rows alike) and never runs during a write. They wait at most
  `search_timeout` seconds for both together, then ConcurrentUseError. embed_pending holds the write lock while it
  embeds, so searches wait for (or time out on) a running embed_pending;
- reads (read, documents, get_meta, stats) take no lock, open their own connection and run alongside everything;
  read() makes its two queries in one read transaction, so it sees one committed version;
- close() refuses new calls (ClosedError), waits for running reads, writes and searches, then releases the files; a
  second close() waits for the first.
Different instances never wait for each other, except on the shared model while it is first built.
"""
from __future__ import annotations

import sqlite3
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

import kb  # opens no port (only `kb.py serve` run as a script listens early) and reads no folder list (kb.ensure_layout)

__all__ = ["KnowledgeBase", "Document", "ConcurrentUseError", "ClosedError"]


class ConcurrentUseError(TimeoutError):
    """A search waited longer than `search_timeout` for another search or a write on the same KnowledgeBase."""


class ClosedError(RuntimeError):
    """The KnowledgeBase was closed."""


# Index files held by a live KnowledgeBase in this process: two instances writing one Tantivy folder or one
# database would corrupt the first and race on the second. The lock guards the set only.
_OPEN: set[Path] = set()
_OPEN_LOCK = threading.Lock()


def _nested(a: Path, b: Path) -> bool:
    """`a` and `b` (resolved) are the same path, or one contains the other."""
    return a == b or a.is_relative_to(b) or b.is_relative_to(a)


@dataclass
class Document:
    path: str  # the document's id in the index, e.g. "zotero/ABCD1234" or "uploads/report.md"
    title: str
    text: str  # Markdown; split into passages at headings, like a note
    source: str = "zotero"  # kb.SOURCE_WEIGHTS; "zotero" also keeps a `kb.py index` run on this file from deleting it
    folder: str = ""
    tags: list[str] = field(default_factory=list)
    links: list[str] = field(default_factory=list)
    meta: dict | None = None  # shown with results (authors, year, citekey, doi, ...)
    version: float | None = None  # change signature, stored as notes.mtime; default: now


class KnowledgeBase:
    def __init__(self, db_path, model_dir=None, *, keyword_dir=None, backend: str = "auto", embedder=None,
                 vector_gate: float | None = None, search_timeout: float = 60.0) -> None:
        """Opens (creating if needed) the index at `db_path`, keyword index in `keyword_dir` (default: `tantivy/`
        beside the database). `model_dir` (default kb.MODEL_DIR) and `backend` ("auto": MLX on macOS, onnxruntime
        elsewhere; "mlx"; "onnx") pick the shared embedding model, loaded on first use; `embedder` replaces it (any
        callable `(texts, query=False, batch_size=16) -> float32[n, 384]` with an `mlx` attribute). `vector_gate`:
        the cosine below which meaning-only hits are dropped (default kb.VECTOR_GATE). RuntimeError when this process
        already has either path open; ValueError when `keyword_dir` contains the database or lies inside it, or either
        path contains or lies inside one an open KnowledgeBase holds (a keyword rebuild empties its folder);
        keyword_index.KeywordIndexBindingError (a RuntimeError) when `keyword_dir` is another database's keyword index
        (the folder is bound to its database's id, kept in meta db_uuid; an unbound legacy folder is rebuilt and bound)."""
        self.db_path = Path(db_path).resolve()
        self.keyword_dir = Path(keyword_dir).resolve() if keyword_dir is not None else self.db_path.parent / "tantivy"
        if _nested(self.keyword_dir, self.db_path):  # also covers the -wal/-shm files beside the database
            raise ValueError(f"keyword_dir {self.keyword_dir} must not contain or lie inside the database {self.db_path}")
        self.model_dir = Path(model_dir) if model_dir is not None else kb.MODEL_DIR
        self.backend = backend
        kb.resolve_backend(backend)  # an unknown backend fails here, not at the first search
        self.search_timeout = search_timeout
        self._embedder = embedder
        # Lock order: _write_lock, then _search_lock (searches and close() alike); _state is never held while waiting
        # for either.
        self._write_lock = threading.Lock()  # apply + embed_pending, and searches: one version of the index per search
        self._search_lock = threading.Lock()  # search + similar_to_text: the Searcher is not for parallel use
        self._state = threading.Condition()  # guards _closed, _close_done, _reads; notified on the last read, close end
        self._closed = False
        self._close_done = False  # close() has released the files
        self._reads = 0  # reads running now (they take no other lock)
        self._claim()
        try:
            self._searcher = kb.Searcher(writer=True, db_path=self.db_path, keyword_dir=self.keyword_dir,
                                         embed_factory=lambda: self.embedder, vector_gate=vector_gate)
        except BaseException:
            self._release()
            raise

    # ------------------------------------------------------------ lifecycle

    def _claim(self) -> None:
        with _OPEN_LOCK:
            held = [p for p in (self.db_path, self.keyword_dir) if p in _OPEN]
            if held:
                raise RuntimeError(f"already open in this process: {held[0]}")
            for mine in (self.db_path, self.keyword_dir):
                for other in _OPEN:
                    if _nested(mine, other):
                        raise ValueError(f"{mine} overlaps {other}, held by an open KnowledgeBase in this process")
            _OPEN.update((self.db_path, self.keyword_dir))

    def _release(self) -> None:
        with _OPEN_LOCK:
            _OPEN.difference_update((self.db_path, self.keyword_dir))

    def _check_open(self) -> None:
        if self._closed:
            raise ClosedError(f"KnowledgeBase {self.db_path} is closed")

    def close(self) -> None:
        """Refuses new calls, waits for in-flight ones (reads too) and the searcher's background rebuild, then
        releases the files. Idempotent: a call while another runs returns when that one has finished. Other methods
        raise ClosedError once close() has begun."""
        with self._state:
            if self._closed:
                while not self._close_done:
                    self._state.wait()
                return
            self._closed = True
            while self._reads:
                self._state.wait()
        try:
            with self._write_lock, self._search_lock:
                self._searcher.close()
            self._release()
        finally:
            with self._state:
                self._close_done = True
                self._state.notify_all()

    def __enter__(self) -> "KnowledgeBase":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    @property
    def embedder(self):
        return self._embedder if self._embedder is not None else kb.shared_embedder(self.model_dir, self.backend)

    # ------------------------------------------------------------ writes

    def apply(self, add=(), remove=(), meta: dict | None = None) -> dict:
        """One transaction: delete the documents at `remove`, store `add` (replacing any at the same path), set the
        `meta` stamps. All or nothing: on any error nothing is written and the instance stays usable. Vectors of
        passages whose text is unchanged are kept; new passages wait for embed_pending."""
        add, remove = list(add), list(dict.fromkeys(kb.posix(p) for p in remove))
        with self._write_lock, kb.vector_stash():  # a fresh stash: never one inherited from the caller's context
            self._check_open()  # under the lock: close() may have run while this waited
            db = kb.connect(keep=True, path=self.db_path)
            try:
                db.execute("BEGIN IMMEDIATE")
                deleted: set[int] = set()  # chunk ids SQLite may hand out again to other text
                for path in dict.fromkeys(remove + [kb.posix(d.path) for d in add]):
                    deleted.update(r[0] for r in db.execute("SELECT id FROM chunks WHERE path=?", (path,)))
                # kept until the keyword index has re-indexed them, across a close and reopen (review round 3 M1)
                db.executemany("INSERT OR IGNORE INTO keyword_dirty VALUES (?)", [(i,) for i in deleted])
                removed = 0
                for path in remove:
                    removed += db.execute("SELECT 1 FROM notes WHERE path=?", (path,)).fetchone() is not None
                    kb.delete_note(db, path)
                for d in add:
                    kb.store_note(db, kb.posix(d.path), d.title, d.folder, d.source, sorted(set(d.tags)),
                                  sorted(set(d.links)), time.time() if d.version is None else float(d.version),
                                  len(d.text), "", d.meta, d.text)
                for key, value in (meta or {}).items():
                    db.execute("INSERT OR REPLACE INTO meta VALUES (?, ?)", (str(key), str(value)))
                kb.stamp(db, "indexed_at")
                db.commit()
            except BaseException:
                db.rollback()
                raise
            finally:
                db.close()
            self._searcher.changed(full=bool(deleted), replaced=deleted)
        return {"added": len(add), "removed": removed}

    def add_documents(self, docs) -> int:
        return self.apply(add=docs)["added"]

    def remove_document(self, path: str) -> bool:
        return self.apply(remove=[path])["removed"] == 1

    def embed_pending(self, batch: int = 256) -> int:
        """Embeds the passages that have no vector yet; returns how many. Loads the model on first use."""
        with self._write_lock:
            self._check_open()
            db = kb.connect(keep=True, path=self.db_path)
            try:
                if not db.execute("SELECT (SELECT count(*) FROM chunks) - (SELECT count(*) FROM vecs)").fetchone()[0]:
                    return 0  # nothing to do: no model load
                done = kb.embed_pending(db, verbose=False, batch=batch, embedder=self.embedder)
            finally:
                try:
                    db.close()
                finally:  # batches commit one by one: a later batch failing leaves earlier vectors to show (review r4)
                    self._searcher.changed()
        return done

    # ------------------------------------------------------------ search

    def search(self, query: str, limit: int = 8, **filters) -> list[dict]:
        """kb.Searcher.search: keyword and meaning hits fused, one result per document. `filters`: source, folder,
        tag, per_note, exclude_source, collections, year_from, year_to."""
        return self._searching(lambda s: s.search(query, limit, **filters))

    def similar_to_text(self, text: str, exclude: str | None = None, limit: int = 8) -> list[dict]:
        """Documents with passages closest in meaning to `text` (at least 40 characters)."""
        return self._searching(lambda s: s.similar_to_text(text, exclude, limit))

    def _searching(self, call):
        """Holds the write lock too, so no apply or embed_pending commits between the searcher's refresh and its row
        reads (review M1: with chunk ids reused, the search would score one document's vector and return another).
        One deadline covers both locks."""
        self._check_open()
        deadline = time.monotonic() + self.search_timeout
        held = []
        try:
            for lock in (self._write_lock, self._search_lock):  # the order close() takes them in
                if not lock.acquire(timeout=max(0.0, deadline - time.monotonic())):
                    self._check_open()  # close() holds the locks while it waits: ClosedError, not a timeout
                    raise ConcurrentUseError(f"another search or a write (apply, embed_pending) on this KnowledgeBase "
                                             f"ran for over {self.search_timeout:g} s")
                held.append(lock)
            self._check_open()
            return call(self._searcher)
        finally:
            for lock in reversed(held):
                lock.release()

    # ------------------------------------------------------------ reads (own connections, no lock)

    def _read(self, query):
        with self._state:  # registered before the check: close() waits for this read, or this read sees it closed
            self._check_open()
            self._reads += 1
        try:
            db = sqlite3.connect(self.db_path, timeout=60)
            try:
                return query(db)
            finally:
                db.close()
        finally:
            with self._state:
                self._reads -= 1
                if not self._reads:
                    self._state.notify_all()

    def read(self, path: str, max_chars: int = 30000, offset: int = 0, heading: str | None = None) -> dict:
        """A document's indexed text, one page at a time (`next_offset`), as kb.read_note reads Zotero items."""
        rel = kb.posix(path)

        def query(db):
            db.execute("BEGIN")  # one snapshot for both queries: an apply() committing between them is not seen
            rows = db.execute("SELECT heading, text FROM chunks WHERE path=? ORDER BY ord", (rel,)).fetchall()
            wanted = heading.lower().strip("# ") if heading else None
            parts, last = [], None
            for h, t in rows:
                if wanted and wanted not in (h or "").lower():
                    continue
                if h != last:
                    parts.append(f"## {h}" if h else "")
                    last = h
                parts.append(t)
            info = kb.note_info(db, rel)
            db.commit()  # ends the read transaction
            return {**info, **kb._page("\n\n".join(p for p in parts if p), offset, max_chars)}

        return self._read(query)

    def documents(self) -> dict[str, tuple[float, int]]:
        """Every document: path -> (version, size)."""
        return self._read(lambda db: {p: (m, z) for p, m, z in db.execute("SELECT path, mtime, size FROM notes")})

    def get_meta(self, key: str) -> str | None:
        row = self._read(lambda db: db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone())
        return row[0] if row else None

    def stats(self) -> dict:
        """Counts of documents, passages and passages with vectors, documents per source, last write."""
        return self._read(lambda db: kb.stats(db, vault=False))  # vault=False: kb's folder list stays unread
