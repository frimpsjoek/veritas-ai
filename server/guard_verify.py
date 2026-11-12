"""`kb.py verify-guard --index <data folder>`: does an index still hold text the guard rejects? (spec 026 R25)

For every attachment of the default Zotero library whose cached text the guard rejects (judged with the overrides
file of the index's own data folder), short phrases are taken from that text and from the user's highlights on it,
and looked for in each store of the index: the `chunks` table, the SQLite FTS index, the vectors that belong to
such chunks, and the Tantivy keyword index. Counting "Full text" chunks alone could not see a highlight, nor text
that only the keyword index still held under a reused chunk id.

Prints keys and counts, never text: a probe phrase is never printed. The index is opened read-only, so the command
can be pointed at another install's data folder while that install runs. It cannot pass by having checked nothing:
no index, no rejected attachment or no probe is exit status 2, not 0. Exit status 1: something was found, or
could not be checked (the keyword index is unreadable, a rejected text gave no phrase to look for, or the index
was last read under another guard version, that is, by an install not yet upgraded or not yet re-indexed).
"""
from __future__ import annotations

import json
import re
import sqlite3
from pathlib import Path

import zotero

TOKEN = re.compile(r"[A-Za-z0-9]+")
PHRASE = 4  # words in a probe: long enough not to turn up by chance, short enough to fit inside one chunk
MAX_TOKEN = 40  # Tantivy's en_stem analyzer drops longer tokens
PER_TEXT = 24  # probes taken from one cached text, spread evenly over it
PER_MARK = 3  # ... and from one highlight or comment
HITS = 1000  # ids read per probe and store


def _runs(text: str):
    """Runs of plain ASCII words that both tokenizers (FTS5 unicode61, Tantivy's default) split the same way and
    kb.clean() leaves alone: a word with another script's letters, markup or a link ends the run."""
    run: list[str] = []
    for word in text.split():
        tokens = TOKEN.findall(word) if word.isascii() and not re.search(r"[<>\[\]]|://|^data:", word) else None
        if tokens is None or any(len(t) > MAX_TOKEN for t in tokens):
            if run:
                yield run
            run = []
        else:
            run += [t.lower() for t in tokens]
    if run:
        yield run


def _words(text: str) -> str:
    """Every ASCII word of a text, lower case, single-spaced, with a space at each end, to look phrases up in."""
    return " " + " ".join(TOKEN.findall(text.lower())) + " "


def phrases(text: str, limit: int, own: str = " ") -> list[str]:
    """Up to `limit` probe phrases from `text`, spread evenly: PHRASE consecutive words, two of them of five letters
    or more; a shorter text (a highlight) gives its whole run when that is distinctive enough. A phrase that also
    occurs in `own` (the item's rightful text, as `_words` gives it) is left out: finding it would prove nothing."""
    found: list[str] = []
    for run in _runs(text):
        if len(run) < PHRASE:
            if (len(run) >= 2 and sum(map(len, run)) >= 10) or any(len(t) >= 8 for t in run):
                found.append(" ".join(run))
            continue
        for i in range(len(run) - PHRASE + 1):
            window = run[i:i + PHRASE]
            if sum(len(t) >= 5 for t in window) >= 2:
                found.append(" ".join(window))
    found = [p for p in dict.fromkeys(found) if f" {p} " not in own]
    if len(found) <= limit:
        return found
    step = len(found) / limit
    return [found[int(i * step)] for i in range(limit)]


def _tantivy(folder: Path):
    """(searcher function or None, state): state is "ok", "absent" (no keyword index: nothing held) or "unreadable"."""
    if not (folder / "meta.json").exists():
        return None, "absent"
    from keyword_index import FIELDS, KeywordIndex

    keywords = KeywordIndex(folder, writer=False)  # a reader never writes to the folder
    if not keywords.usable():
        return None, "unreadable"
    searcher = keywords.index.searcher()

    def ids(phrase: str) -> list[int]:
        hits = searcher.search(keywords.index.parse_query(f'"{phrase}"', list(FIELDS)), HITS, count=False).hits
        return list(searcher.fast_field_values("id", [address for _, address in hits]))

    return ids, "ok"


def verify(index: Path) -> dict:
    """Counts per store for the index in `index` (a data folder with kb.sqlite and, when built, tantivy/)."""
    result = {"index": str(index), "state": "ok", "tantivy": "absent", "items": [], "rejected": 0, "probes": 0, "unprobed": 0}
    if not (index / "kb.sqlite").is_file():
        return {**result, "state": "no index"}
    overrides = zotero.text_overrides(index / zotero.OVERRIDES_FILE)
    result["overrides"] = len(overrides)
    db = sqlite3.connect(f"file:{index / 'kb.sqlite'}?mode=ro", uri=True, timeout=60)
    try:
        try:
            stamp = db.execute("SELECT value FROM meta WHERE key='zotero_fingerprint'").fetchone()
            result["read_under"] = json.loads(stamp[0])[2] if stamp else None
        except (sqlite3.OperationalError, ValueError, IndexError, TypeError):
            result["read_under"] = None  # no stamp, or one from before the guard was part of it
        keyword_ids, result["tantivy"] = _tantivy(index / "tantivy")
        for item in zotero.rejected_items(overrides):
            path = zotero.PREFIX + item["item"]
            own = _words("\n".join(item["own"]))
            probes: list[str] = []
            for rejected in item["rejected"]:
                result["rejected"] += 1
                cache, *marks = rejected["texts"]
                mine = phrases(cache, PER_TEXT, own) + [p for mark in marks for p in phrases(mark, PER_MARK, own)]
                result["unprobed"] += not mine
                probes += mine
            probes = list(dict.fromkeys(probes))
            result["probes"] += len(probes)
            rows = db.execute("SELECT id, heading, text FROM chunks WHERE path=?", (path,)).fetchall()
            chunk_ids = {cid for cid, _heading, text in rows if any(f" {p} " in _words(text) for p in probes)}

            def held(ids) -> set[int]:
                """Of the ids a store returned, those that are this item's chunks or belong to no chunk at all (an
                entry the index lost track of). Another item's chunk with the same words is that item's business."""
                out = set()
                for cid in ids:
                    row = db.execute("SELECT path FROM chunks WHERE id=?", (cid,)).fetchone()
                    if row is None or row[0] == path:
                        out.add(cid)
                return out

            fts_ids: set[int] = set()
            tantivy_ids: set[int] = set()
            for probe in probes:
                fts_ids |= held(r[0] for r in db.execute(
                    "SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ? LIMIT ?", (f'"{probe}"', HITS)))
                if keyword_ids is not None:
                    tantivy_ids |= held(keyword_ids(probe))
            leaked = sorted(chunk_ids | fts_ids | tantivy_ids)
            vectors = sum(db.execute("SELECT count(*) FROM vecs WHERE id=?", (cid,)).fetchone()[0] for cid in leaked)
            vectors += db.execute("SELECT count(*) FROM vecs WHERE path=? AND id NOT IN (SELECT id FROM chunks)", (path,)).fetchone()[0]
            # Spec 026 R4's count: an item with no accepted attachment has no "Full text" section at all.
            full_text = 0 if item["accepted"] else sum("Full text" in (heading or "") for _cid, heading, _text in rows)
            result["items"].append({"item": item["item"], "chunks": len(chunk_ids), "fts": len(fts_ids), "vectors": vectors,
                                    "tantivy": len(tantivy_ids), "full_text": full_text})
    finally:
        db.close()
    return result


STORES = ("chunks", "fts", "vectors", "tantivy", "full_text")


def cli(index: str | None = None) -> int:
    """Prints the report; returns the exit status (0 clean, 1 found or unverifiable, 2 nothing was checked)."""
    import kb

    folder = Path(index).expanduser() if index else kb.data_dir()
    if not zotero.available():
        print(f"verify-guard: no Zotero library at {zotero.root()}; nothing was checked")
        return 2
    result = verify(folder)
    if result["state"] != "ok":
        print(f"verify-guard: no index (kb.sqlite) in {folder}; nothing was checked")
        return 2
    print(f"verify-guard: index {folder}; library {zotero.root()}; guard version {zotero.TEXT_GUARD_VERSION}; "
          f"index read under guard version {'none' if result['read_under'] is None else result['read_under']}; "
          f"{result['overrides']} overrides from {folder / zotero.OVERRIDES_FILE}; tantivy {result['tantivy']}")
    totals = dict.fromkeys(STORES, 0)
    for row in result["items"]:
        for store in STORES:
            totals[store] += row[store]
        if any(row[store] for store in STORES):
            print(f"{row['item']} " + " ".join(f"{store}={row[store]}" for store in STORES))
    summary = (f"verify-guard: rejected={result['rejected']} items={len(result['items'])} probes={result['probes']} "
               f"unprobed={result['unprobed']} " + " ".join(f"{store}={totals[store]}" for store in STORES))
    if not result["rejected"] or not result["probes"]:
        print(f"{summary} -> nothing to verify (no rejected attachment, or no phrase to look for): this is not a pass")
        return 2
    if any(totals.values()):
        print(f"{summary} -> NOT clean")
        return 1
    if result["tantivy"] == "unreadable" or result["unprobed"] or result["read_under"] != zotero.TEXT_GUARD_VERSION:
        print(f"{summary} -> NOT verified (the index was last read under another guard version, the keyword index is "
              f"unreadable, or a rejected attachment gave no phrase to look for)")
        return 1
    print(f"{summary} -> clean")
    return 0
