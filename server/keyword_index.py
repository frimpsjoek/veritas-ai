"""Keyword (BM25) search with Tantivy, an in-memory-fast search engine, kept in step with the SQLite index.

SQLite FTS5 has to score every chunk that contains a query word before it can rank them, so a query with
"machine" or "learning" in it scored ~150k chunks (15-100 ms). Tantivy skips blocks that cannot make the top k
(block-max WAND): the top 600 of 290k chunks come back in 1-2 ms with every query word counted.

The Tantivy index is derived data: it lives in data/tantivy, is rebuilt from SQLite when missing or broken
(~7 s), and only the index server writes to it (`writer=True`); every other process reads.
"""
from __future__ import annotations

import os
import re
import shutil
import sqlite3
from pathlib import Path

import numpy as np
import tantivy

# One text field holding title (twice), heading, text and tags. Separate fields made Tantivy compute word
# rarity per field, so a word in a title looked very rare and title matches swamped everything (right note first
# 3/11 on eval.py); one field ranks like SQLite FTS5 did (6/11), with the repeated title as its title weight.
FIELDS = ("body",)
SCHEMA_VERSION = "2"
RARE = 3000  # chunks; a word in more than this many is too common to find anything on its own


def _schema() -> tantivy.Schema:
    builder = tantivy.SchemaBuilder()
    builder.add_integer_field("id", stored=True, indexed=True, fast=True)
    builder.add_text_field("body", stored=False, tokenizer_name="en_stem")
    return builder.build()


class KeywordIndex:
    def __init__(self, path: Path, writer: bool) -> None:
        self.path = path
        self.can_write = writer
        self.ids_file = path / "ids.npy"
        self.index: tantivy.Index | None = None
        self.ids: set[int] = set()
        try:
            version = (path / "schema-version").read_text().strip() if (path / "schema-version").exists() else ""
            if (path / "meta.json").exists() and version == SCHEMA_VERSION:
                self.index = tantivy.Index(_schema(), path=str(path))
                self.ids = set(np.load(self.ids_file).tolist()) if self.ids_file.exists() else set()
        except Exception:  # noqa: BLE001 - a broken index is rebuilt by the writer
            self.index = None

    def usable(self) -> bool:
        return self.index is not None

    def sync(self, db: sqlite3.Connection) -> int:
        """Adds new chunks and removes deleted ones. Returns how many documents changed."""
        if not self.can_write:
            if self.index is not None:
                self.index.reload()
            return 0
        live = {r[0] for r in db.execute("SELECT id FROM chunks")}
        if self.index is None or (self.ids and not self.ids & live and live):
            return self._rebuild(db, live)
        new, gone = live - self.ids, self.ids - live
        if not new and not gone:
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
        return len(new) + len(gone)

    def _rebuild(self, db: sqlite3.Connection, live: set[int]) -> int:
        shutil.rmtree(self.path, ignore_errors=True)
        os.makedirs(self.path)
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
        sql = "SELECT c.id, n.title, c.heading, c.text, n.tags FROM chunks c JOIN notes n ON n.path=c.path"
        batches = [None] if ids is None else [ids[i:i + 900] for i in range(0, len(ids), 900)]
        for batch in batches:
            rows = db.execute(sql) if batch is None else db.execute(
                f"{sql} WHERE c.id IN ({','.join('?' * len(batch))})", batch)
            for cid, title, heading, text, tags in rows:
                title = title or ""
                # Delete before add: a crash between commit and ids.npy save can re-add an already-committed
                # id on the next sync, and a delete-then-add makes that a no-op replace instead of a duplicate.
                writer.delete_documents("id", cid)
                writer.add_document(tantivy.Document(
                    id=cid, body="\n".join((title, title, heading or "", text or "", tags or ""))))

    def _save_ids(self) -> None:
        np.save(self.ids_file, np.fromiter(self.ids, dtype=np.int64, count=len(self.ids)))

    def search(self, terms: list[str], limit: int, enough: int = 200) -> list[int]:
        """Chunk ids, best first, in stages: chunks with every word; if fewer than `enough`, chunks with all but
        one word; then chunks with any word (BM25 ranks rare words highest). Ranking on any word alone lets one
        rare word win (a note that merely mentions "photoshoots" beating the pricing note that answers the
        question), which cost recall; each stage here is ~1 ms."""
        words = [w for w in " ".join(re.sub(r"[^\w]", " ", t) for t in terms).split() if w][:8]
        if not words or self.index is None:
            return []
        out: list[int] = []
        seen: set[int] = set()
        searcher = self.index.searcher()

        def run(query: str, n: int) -> None:
            try:
                parsed = self.index.parse_query(query, list(FIELDS))
            except ValueError:
                return
            hits = searcher.search(parsed, n, count=False).hits
            # Ids come from the column store (fast field): reading stored documents instead cost ~20 ms per stage.
            for cid in searcher.fast_field_values("id", [address for _, address in hits]):
                if cid not in seen:
                    seen.add(cid)
                    out.append(cid)

        run(" ".join(f"+{w}" for w in words), limit)
        if len(out) < enough and len(words) > 2:
            for i in range(len(words)):
                run(" ".join(f"+{w}" for j, w in enumerate(words) if j != i), enough)
        if len(out) < enough:
            # Any of the rarer words only: a common word ("learning", "time") ORed in adds thousands of loosely
            # related chunks that outvote the meaning-based side in the fused ranking (tested: 6/11 → 3/11 top-1).
            rare = [w for w in words if self._count(searcher, w) < RARE] or []
            if rare:
                run(" ".join(rare), limit)
        return out[:limit]

    def _count(self, searcher, word: str) -> int:
        try:
            return searcher.search(self.index.parse_query(word, list(FIELDS)), 1, count=True).count
        except ValueError:
            return RARE
