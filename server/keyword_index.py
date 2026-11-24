"""Keyword (BM25) search with Tantivy, an in-memory-fast search engine, kept in step with the SQLite index.

SQLite FTS5 has to score every chunk that contains a query word before it can rank them, so a query with
"machine" or "learning" in it scored ~150k chunks (15-100 ms). Tantivy skips blocks that cannot make the top k
(block-max WAND): the top 600 of 290k chunks come back in 1-2 ms with every query word counted.

The Tantivy index is derived data: it lives in data/tantivy, is rebuilt from SQLite when missing or broken
(~7 s), and only the index server writes to it (`writer=True`); every other process reads.

A keyword folder is bound to one database: MARKER names the database's identity (a random id in its meta table, key
db_uuid), since chunk ids are only row numbers and two databases share them. A folder bound to another database (or
bound at all, when the database has no identity yet) is refused, untouched; one bound to none (made before the
binding) is rebuilt once from the database and bound.
"""
from __future__ import annotations

import os
import re
import sqlite3
import uuid
from pathlib import Path

import numpy as np
import tantivy

# One text field holding title (twice), heading, text and tags. Separate fields made Tantivy compute word
# rarity per field, so a word in a title looked very rare and title matches swamped everything (right note first
# 3/11 on eval.py); one field ranks like SQLite FTS5 did (6/11), with the repeated title as its title weight.
FIELDS = ("body",)
SCHEMA_VERSION = "3"  # + raw path term, used for native pre-limit path-prefix visibility
RARE = 3000  # chunks; a word in more than this many is too common to find anything on its own

# A rebuild empties the keyword folder first, and the folder may be one a caller named (veritas_kb.KnowledgeBase), so
# it is emptied only when it holds nothing but files Tantivy or this module writes: never a subfolder, a link, a
# database or anything else. MARKER is written at every rebuild. A folder from before it (legacy data/tantivy) must
# have both legacy files and open as a Tantivy index with this module's schema, current or the previous (v2) one: those
# familiar filenames alone could belong to any application.
MARKER = ".veritas-keyword-index"
_OWN_FILES = {"meta.json", ".managed.json", ".tantivy-meta.lock", ".tantivy-writer.lock", "schema-version", "ids.npy",
              MARKER}
_TANTIVY_FILE = re.compile(r"[0-9a-f]{32}(\.\d+)?\.(idx|pos|term|store|fast|fieldnorm|del)"  # segment files
                           r"|\.tmp[A-Za-z0-9]{6}")  # an atomic write's temporary file, left by a crash


_BOUND_TO = re.compile(r"^database: (\S+)$", re.MULTILINE)  # the MARKER line naming the database's identity


class NotAKeywordIndexError(RuntimeError):
    """The keyword folder holds files this index did not write; it is left as it is."""


class KeywordIndexBindingError(RuntimeError):
    """The keyword folder is the index of another database; it is left as it is."""


def database_id(db: sqlite3.Connection, create: bool) -> str | None:
    """The database's identity (meta db_uuid), made on first use when `create`. None when there is none (yet), or no
    meta table to keep it in."""
    try:
        row = db.execute("SELECT value FROM meta WHERE key='db_uuid'").fetchone()
        if row is None and create:
            db.execute("INSERT OR IGNORE INTO meta (key, value) VALUES ('db_uuid', ?)", (uuid.uuid4().hex,))
            db.commit()
            row = db.execute("SELECT value FROM meta WHERE key='db_uuid'").fetchone()
    except sqlite3.OperationalError:
        return None
    return row[0] if row else None


def bound_to(path: Path) -> str | None:
    """The identity of the database the folder is bound to; None for an unbound (or missing) folder."""
    try:
        found = _BOUND_TO.search((path / MARKER).read_text())
    except (OSError, UnicodeDecodeError):
        return None
    return found.group(1) if found else None


def owned_by_index(path: Path) -> bool:
    """True when `path` is missing, empty, marked, or positively validated as a legacy index."""
    if not os.path.lexists(path):
        return True
    if not path.is_dir():
        return False
    entries = list(path.iterdir())
    for entry in entries:
        if entry.is_symlink() or not entry.is_file():
            return False
        if entry.name not in _OWN_FILES and not _TANTIVY_FILE.fullmatch(entry.name):
            return False
    names = {e.name for e in entries}
    if not names or MARKER in names:
        return True
    if not {"meta.json", "schema-version"} <= names:
        return False
    try:
        schema = tantivy.Index.open(str(path)).schema
        return schema == _schema() or schema == _schema(legacy_v2=True)
    except Exception:  # noqa: BLE001 - any unreadable or non-Tantivy metadata fails closed
        return False


def _clear(path: Path) -> None:
    """Empties the keyword folder (files only, never recursively), or refuses when it is not this index's."""
    if not owned_by_index(path):
        raise NotAKeywordIndexError(
            f"{path} is not a keyword index (it holds other files or folders); refusing to clear it for a rebuild. "
            f"Give the index its own empty keyword folder.")
    if path.is_dir():
        for entry in path.iterdir():
            entry.unlink()


def _schema(legacy_v2: bool = False) -> tantivy.Schema:
    """This module's schema; `legacy_v2`: the one before the path term (SCHEMA_VERSION 2), which a pre-marker folder
    may still hold. owned_by_index accepts that known layout so the schema bump rebuilds it instead of refusing it."""
    builder = tantivy.SchemaBuilder()
    builder.add_integer_field("id", stored=True, indexed=True, fast=True)
    builder.add_text_field("body", stored=False, tokenizer_name="en_stem")
    if legacy_v2:
        return builder.build()
    # One whole, literal path term. RegexQuery full-matches terms; `<escaped prefix>(.+)?` is therefore exactly
    # Python's path.startswith(prefix), including a document whose path is the prefix itself. Do not anchor with ^:
    # tantivy 0.26 rejects that as an empty-match operator.
    builder.add_text_field("path", stored=False, tokenizer_name="raw")
    return builder.build()


class KeywordIndex:
    def __init__(self, path: Path, writer: bool, db: sqlite3.Connection | None = None, rebind: bool = False) -> None:
        """`db`: the database this index belongs to; the folder's binding is checked against it now
        (KeywordIndexBindingError for a folder bound to another), otherwise at the first sync. A database no writer
        has opened has no identity yet, so a bound folder cannot be shown to be its own: it counts as another's, for a
        reader too. `rebind`: the folder is the module's own (data/tantivy beside kb.DB_PATH), rebuilt for this
        database instead of refused when bound to another (a reader leaves it unloaded and searches SQLite FTS)."""
        self.path = path
        self.can_write = writer
        self.rebind = rebind
        self.ids_file = path / "ids.npy"
        self.index: tantivy.Index | None = None
        self.ids: set[int] = set()
        if db is not None:
            mine, bound = database_id(db, create=writer), bound_to(path)
            if bound is not None and bound != mine:  # bound to another database, or this one has no identity
                if not rebind:
                    raise self._foreign(db, mine, bound)
                return  # not loaded: the writer's first sync rebuilds and binds it
            if bound is None and mine is not None and writer:
                return  # not loaded: the writer's first sync rebuilds and binds it (a reader keeps an unbound one)
        try:
            version = (path / "schema-version").read_text().strip() if (path / "schema-version").exists() else ""
            if (path / "meta.json").exists() and version == SCHEMA_VERSION:
                self.index = tantivy.Index(_schema(), path=str(path))
                self.ids = set(np.load(self.ids_file).tolist()) if self.ids_file.exists() else set()
        except Exception:  # noqa: BLE001 - a broken index is rebuilt by the writer
            self.index = None

    def usable(self) -> bool:
        return self.index is not None

    def sync(self, db: sqlite3.Connection, replaced: set[int] | frozenset[int] = frozenset()) -> int:
        """Adds new chunks and removes deleted ones. `replaced`: chunk ids whose rows were deleted since the last sync;
        one that exists again (SQLite reused the id for other text) is indexed afresh. The ids in the keyword_dirty
        table count as replaced too, and are dropped from it once Tantivy has committed. Returns how many documents
        changed."""
        if not self.can_write:
            if self.index is not None:
                self.index.reload()
            return 0
        mine, bound = database_id(db, create=True), bound_to(self.path)
        if mine is not None and bound is not None and bound != mine and not self.rebind:
            raise self._foreign(db, mine, bound)  # checked before any rebuild, which would empty the folder
        dirty = self._dirty(db)
        live = {r[0] for r in db.execute("SELECT id FROM chunks")}
        if self.index is None or (mine is not None and bound != mine) or (self.ids and not self.ids & live and live):
            changed = self._rebuild(db, live, mine)
            self._clean(db, dirty)
            return changed
        new, gone = (live - self.ids) | ((set(replaced) | dirty) & live), self.ids - live
        if not new and not gone:
            self._clean(db, dirty)
            return 0
        writer = self.index.writer(heap_size=200_000_000, num_threads=2)
        for cid in gone:
            writer.delete_documents("id", cid)
        self._add(writer, db, sorted(new))
        writer.commit()
        writer.wait_merging_threads()
        self.ids = (self.ids - gone) | new
        self._save_ids()
        self.index.reload()
        self._clean(db, dirty)
        return len(new) + len(gone)

    def _foreign(self, db: sqlite3.Connection, mine: str | None, bound: str) -> KeywordIndexBindingError:
        name = next((r[2] for r in db.execute("PRAGMA database_list") if r[1] == "main"), "") or "this database"
        ident = f"id {mine}" if mine is not None else "no id yet: no writer has opened it"
        return KeywordIndexBindingError(
            f"{self.path} is the keyword index of another database (id {bound}), not of {name} ({ident}); refusing "
            f"to use or rebuild it. Give each database its own keyword folder (or delete this one if its database is "
            f"gone).")

    @staticmethod
    def _dirty(db: sqlite3.Connection) -> set[int]:
        try:
            return {r[0] for r in db.execute("SELECT id FROM keyword_dirty")}
        except sqlite3.OperationalError:  # a database made before the table (kb.connect adds it)
            return set()

    @staticmethod
    def _clean(db: sqlite3.Connection, dirty: set[int]) -> None:
        """Drops the ids read before the commit. KnowledgeBase runs no apply() during a sync (searches hold its write
        lock), so none is marked again in between."""
        if dirty:
            db.executemany("DELETE FROM keyword_dirty WHERE id=?", [(cid,) for cid in dirty])
            db.commit()

    def _rebuild(self, db: sqlite3.Connection, live: set[int], database: str | None = None) -> int:
        _clear(self.path)
        os.makedirs(self.path, exist_ok=True)
        (self.path / MARKER).write_text("Tantivy keyword index of a Veritas kb.sqlite; rebuilt from it when needed.\n"
                                        + (f"database: {database}\n" if database else ""))
        self.index = tantivy.Index(_schema(), path=str(self.path))
        (self.path / "schema-version").write_text(SCHEMA_VERSION)
        writer = self.index.writer(heap_size=300_000_000, num_threads=4)
        self._add(writer, db, None)
        writer.commit()
        writer.wait_merging_threads()
        self.ids = live
        self._save_ids()
        self.index.reload()
        return len(live)

    def _add(self, writer, db: sqlite3.Connection, ids: list[int] | None) -> None:
        sql = "SELECT c.id, c.path, n.title, c.heading, c.text, n.tags FROM chunks c JOIN notes n ON n.path=c.path"
        batches = [None] if ids is None else [ids[i:i + 900] for i in range(0, len(ids), 900)]
        for batch in batches:
            rows = db.execute(sql) if batch is None else db.execute(
                f"{sql} WHERE c.id IN ({','.join('?' * len(batch))})", batch)
            for cid, path, title, heading, text, tags in rows:
                title = title or ""
                # Delete before add: a crash between commit and ids.npy save can re-add an already-committed
                # id on the next sync, and a delete-then-add makes that a no-op replace instead of a duplicate.
                writer.delete_documents("id", cid)
                writer.add_document(tantivy.Document(
                    id=cid, path=path, body="\n".join((title, title, heading or "", text or "", tags or ""))))

    def _save_ids(self) -> None:
        np.save(self.ids_file, np.fromiter(self.ids, dtype=np.int64, count=len(self.ids)))

    def _with_paths(self, query: tantivy.Query, path_prefixes: tuple[str, ...] | None) -> tantivy.Query:
        """AND a zero-score literal path-prefix predicate into a keyword query before Tantivy applies its limit."""
        if path_prefixes is None:
            return query
        # RegexQuery full-matches a raw term. re.escape also handles spaces and Tantivy/Rust regex metacharacters.
        # (?s:.*): the suffix may contain newlines, as for the SQLite and vector filters (review L3E r2).
        pattern = "(?:" + "|".join(re.escape(prefix) for prefix in path_prefixes) + ")(?s:.*)"
        paths = tantivy.Query.regex_query(self.index.schema, "path", pattern)
        return query.and_must_match(tantivy.Query.const_score_query(paths, 0.0))

    def search(self, terms: list[str], limit: int, enough: int = 200, *,
               path_prefixes: tuple[str, ...] | None = None, exhaustive: bool = False) -> list[int]:
        """Chunk ids, best first, in stages: chunks with every word; if fewer than `enough`, chunks with all but
        one word; then chunks with any word (BM25 ranks rare words highest). Ranking on any word alone lets one
        rare word win (a note that merely mentions "photoshoots" beating the pricing note that answers the
        question), which cost recall; each stage here is ~1 ms. Optional path filtering happens inside every query,
        including term-frequency selection; `exhaustive` returns every candidate rather than the usual bounded pool."""
        words = [w for w in " ".join(re.sub(r"[^\w]", " ", t) for t in terms).split() if w][:8]
        if not words or self.index is None or path_prefixes == ():
            return []
        out: list[int] = []
        seen: set[int] = set()
        searcher = self.index.searcher()

        def run(query: str, n: int) -> None:
            try:
                parsed = self._with_paths(self.index.parse_query(query, list(FIELDS)), path_prefixes)
            except ValueError:
                return
            result = searcher.search(parsed, 1 if exhaustive else n, count=exhaustive)
            if exhaustive and result.count > len(result.hits):
                result = searcher.search(parsed, result.count, count=False)
            # Ids come from the column store (fast field): reading stored documents instead cost ~20 ms per stage.
            for cid in searcher.fast_field_values("id", [address for _, address in result.hits]):
                if cid not in seen:
                    seen.add(cid)
                    out.append(cid)

        run(" ".join(f"+{w}" for w in words), limit)
        if (exhaustive or len(out) < enough) and len(words) > 2:
            for i in range(len(words)):
                run(" ".join(f"+{w}" for j, w in enumerate(words) if j != i), enough)
        if exhaustive or len(out) < enough:
            # Any of the rarer words only: a common word ("learning", "time") ORed in adds thousands of loosely
            # related chunks that outvote the meaning-based side in the fused ranking (tested: 6/11 → 3/11 top-1).
            rare = [w for w in words if self._count(searcher, w, path_prefixes) < RARE] or []
            if rare:
                run(" ".join(rare), limit)
        return out if exhaustive else out[:limit]

    def _count(self, searcher, word: str, path_prefixes: tuple[str, ...] | None = None) -> int:
        try:
            query = self._with_paths(self.index.parse_query(word, list(FIELDS)), path_prefixes)
            return searcher.search(query, 1, count=True).count
        except ValueError:
            return RARE
