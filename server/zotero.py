"""Reads the local Zotero library as documents for the index: one per top-level item.

Each document holds the item's metadata, abstract, the user's child notes, PDF highlights and comments, and the
full text Zotero already extracted (storage/<attachment key>/.zotero-ft-cache), so no PDF is parsed here.

zotero.sqlite is read through SQLite's backup API into a private copy: consistent even while Zotero is open and
writing (the database is in WAL mode), and Zotero's own file is never opened for writing.
"""
from __future__ import annotations

import html
import json
import os
import re
import shutil
import sqlite3
import tempfile
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

ZOTERO = Path(os.environ.get("KB_ZOTERO", Path.home() / "Zotero"))
PREFIX = "zotero/"  # index paths look like zotero/ABCD1234; they are not vault files
SKIP_TYPES = ("attachment", "note", "annotation")
# Status tags written by Zotero plugins (#broken, #nosource, /unread, linter/error, zotmoov, notion): not topics.
HOUSEKEEPING_TAG = re.compile(r"^([#/]|linter/)|^(zotmoov|notion)$", re.I)


@dataclass
class ZoteroDoc:
    key: str
    title: str
    text: str
    tags: list[str]
    signature: float  # changes whenever the item, its notes, highlights or full text change
    meta: dict = field(default_factory=dict)

    @property
    def path(self) -> str:
        return PREFIX + self.key


def available() -> bool:
    return (ZOTERO / "zotero.sqlite").is_file()


def fingerprint() -> tuple[float, float]:
    """Cheap change check: the database's mtime (with its WAL) and the newest full-text cache."""
    db = max((ZOTERO / n).stat().st_mtime for n in ("zotero.sqlite", "zotero.sqlite-wal") if (ZOTERO / n).exists())
    newest = 0.0
    storage = ZOTERO / "storage"
    if storage.is_dir():
        for entry in os.scandir(storage):
            cache = os.path.join(entry.path, ".zotero-ft-cache")
            try:
                newest = max(newest, os.stat(cache).st_mtime)
            except OSError:
                pass
    return db, newest


def snapshot(name: str = "index", max_age: float = 0) -> sqlite3.Connection:
    """A private copy of zotero.sqlite. Each user (the indexer, the reading view) keeps its own file, so one
    never reads a copy the other is rewriting; `max_age` reuses a recent copy instead of taking a new one."""
    path = os.path.join(tempfile.gettempdir(), f"kb-zotero-{name}.sqlite")
    if max_age and os.path.exists(path) and time.time() - os.path.getmtime(path) < max_age:
        return sqlite3.connect(path)
    database = ZOTERO / "zotero.sqlite"
    source = sqlite3.connect(f"file:{database}?mode=ro", uri=True, timeout=2)
    try:
        source.execute("SELECT 1 FROM sqlite_master LIMIT 1")
    except sqlite3.OperationalError:
        # Zotero holds an exclusive lock while it runs, and a normal backup would wait on it forever. Copy the
        # files instead: the database and its write-ahead log, where Zotero keeps its latest changes until a
        # checkpoint (reading the database alone, as immutable=1 does, misses them). Opening the copy replays the
        # log. Keep it only if it is consistent, since a write may be under way.
        source.close()
        wal = Path(str(database) + "-wal")
        for _ in range(5):
            with tempfile.TemporaryDirectory() as tmp:
                base = Path(tmp) / "zotero.sqlite"
                shutil.copyfile(database, base)
                if wal.exists():
                    shutil.copyfile(wal, Path(str(base) + "-wal"))
                try:
                    source = sqlite3.connect(base)
                    ok = source.execute("PRAGMA quick_check").fetchone()[0] == "ok"
                    if ok:
                        copy = sqlite3.connect(path)
                        source.backup(copy)
                        source.close()
                        return copy
                    source.close()
                except sqlite3.DatabaseError:
                    pass
            time.sleep(2)
        raise RuntimeError("couldn't take a consistent copy of zotero.sqlite while Zotero is writing to it")
    copy = sqlite3.connect(path)
    source.backup(copy)
    source.close()
    return copy


def _epoch(stamp: str | None) -> float:
    if not stamp:
        return 0.0
    try:
        return datetime.strptime(stamp[:19], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc).timestamp()
    except ValueError:
        return 0.0


def _note_text(note_html: str) -> str:
    text = re.sub(r"<br\s*/?>|</p>|</h\d>|</li>|</div>", "\n", note_html or "", flags=re.I)
    text = re.sub(r"<h(\d)[^>]*>", lambda m: "\n" + "#" * min(int(m.group(1)) + 2, 6) + " ", text, flags=re.I)
    text = re.sub(r"<li[^>]*>", "- ", text, flags=re.I)
    text = html.unescape(re.sub(r"<[^>]+>", "", text))
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def documents() -> list[ZoteroDoc]:
    db = snapshot("index")
    q = lambda sql, *args: db.execute(sql, args).fetchall()  # noqa: E731
    deleted = {r[0] for r in q("SELECT itemID FROM deletedItems")}
    items = q("""SELECT i.itemID, i.key, t.typeName, i.dateModified FROM items i JOIN itemTypes t USING(itemTypeID)
                 WHERE i.libraryID = 1""")
    fields: dict[int, dict[str, str]] = {}
    for item_id, name, value in q("""SELECT d.itemID, f.fieldName, v.value FROM itemData d JOIN fields f USING(fieldID)
                                     JOIN itemDataValues v USING(valueID)"""):
        fields.setdefault(item_id, {})[name] = str(value)
    creators: dict[int, list[str]] = {}
    for item_id, first, last in q("""SELECT ic.itemID, c.firstName, c.lastName FROM itemCreators ic
                                    JOIN creators c USING(creatorID) ORDER BY ic.itemID, ic.orderIndex"""):
        creators.setdefault(item_id, []).append(" ".join(p for p in (first, last) if p))
    tags: dict[int, list[str]] = {}
    for item_id, name in q("SELECT it.itemID, t.name FROM itemTags it JOIN tags t USING(tagID)"):
        if not HOUSEKEEPING_TAG.match(name.strip()):
            tags.setdefault(item_id, []).append(re.sub(r"\s+", "-", name.strip()))
    collections: dict[int, list[str]] = {}
    collection_keys: dict[int, list[str]] = {}
    for item_id, name, ckey in q(
            "SELECT ci.itemID, c.collectionName, c.key FROM collectionItems ci JOIN collections c USING(collectionID)"):
        collections.setdefault(item_id, []).append(name)
        collection_keys.setdefault(item_id, []).append(ckey)
    modified = {item_id: _epoch(stamp) for item_id, _, _, stamp in items}
    keys = {item_id: key for item_id, key, _, _ in items}

    notes: dict[int, list[tuple[int, str]]] = {}
    for item_id, parent, note in q("SELECT itemID, parentItemID, note FROM itemNotes WHERE parentItemID IS NOT NULL"):
        if item_id not in deleted:
            notes.setdefault(parent, []).append((item_id, _note_text(note)))
    attachments: dict[int, list[int]] = {}
    for item_id, parent in q("SELECT itemID, parentItemID FROM itemAttachments WHERE parentItemID IS NOT NULL"):
        if item_id not in deleted:
            attachments.setdefault(parent, []).append(item_id)
    annotations: dict[int, list[tuple]] = {}
    for item_id, parent, text, comment, page, sort in q(
            "SELECT itemID, parentItemID, text, comment, pageLabel, sortIndex FROM itemAnnotations"):
        if item_id not in deleted and (text or comment):
            annotations.setdefault(parent, []).append((sort, page, text, comment, item_id))

    docs = []
    for item_id, key, type_name, _ in items:
        if type_name in SKIP_TYPES or item_id in deleted:
            continue
        f = fields.get(item_id, {})
        title = f.get("title") or f.get("shortTitle") or key
        authors = creators.get(item_id, [])
        year = (re.search(r"\d{4}", f.get("date", "")) or [""])[0]
        venue = f.get("publicationTitle") or f.get("proceedingsTitle") or f.get("bookTitle") or f.get("websiteTitle") or ""
        byline = ", ".join(authors[:6]) + (" et al." if len(authors) > 6 else "")
        parts = [f"# {title}", " · ".join(p for p in (byline, year, venue, f.get("DOI", "")) if p)]
        if f.get("abstractNote"):
            parts += ["## Abstract", f["abstractNote"]]
        signature = modified.get(item_id, 0.0)
        child_notes = notes.get(item_id, [])
        if child_notes:
            parts.append("## My notes")
            parts += [text for _, text in child_notes if text]
            signature = max([signature] + [modified.get(n, 0.0) for n, _ in child_notes])
        highlights = []
        full_texts = []
        for attachment in attachments.get(item_id, []):
            signature = max(signature, modified.get(attachment, 0.0))
            for sort, page, text, comment, annotation in sorted(annotations.get(attachment, [])):
                signature = max(signature, modified.get(annotation, 0.0))
                line = f"> {text.strip()}" if text else ""
                if comment:
                    line += ("\n" if line else "") + f"Comment: {comment.strip()}"
                highlights.append(line + (f" (p. {page})" if page else ""))
            cache = ZOTERO / "storage" / keys[attachment] / ".zotero-ft-cache"
            if cache.is_file():
                signature = max(signature, cache.stat().st_mtime)
                full_texts.append(cache.read_text(encoding="utf-8", errors="replace"))
        if highlights:
            parts += ["## Highlights"] + highlights
        for text in full_texts:
            parts += ["## Full text", text]
        text = "\n\n".join(p for p in parts if p)
        docs.append(ZoteroDoc(
            key=key, title=title, text=text, signature=signature,
            tags=tags.get(item_id, []),
            meta={"authors": authors, "year": year, "venue": venue, "doi": f.get("DOI", ""), "url": f.get("url", ""),
                  "citekey": f.get("citationKey", ""), "type": type_name,
                  "collections": sorted(collections.get(item_id, [])),
                  "collection_keys": sorted(collection_keys.get(item_id, [])),
                  "zotero_uri": f"zotero://select/library/items/{key}"}))
    db.close()
    return docs


def collection_tree() -> list[dict]:
    """Every collection in the library: its key, name, and its parent's key (None at the top level). Read fresh
    from Zotero's own `collections` table; kb.index_zotero rewrites the `collections` table in kb.sqlite from
    this on each pass that actually re-reads Zotero."""
    db = snapshot("index", max_age=60)
    rows = db.execute(
        "SELECT collectionID, collectionName, parentCollectionID, key FROM collections WHERE libraryID=1").fetchall()
    db.close()
    key_of = {collection_id: key for collection_id, _, _, key in rows}
    return [{"key": key, "name": name, "parent": key_of.get(parent)} for _, name, parent, key in rows]


ANNOTATION_TYPES = {1: "highlight", 2: "note", 3: "image", 4: "ink", 5: "underline", 6: "text"}


def _position(raw: str | None) -> dict | None:
    """An annotation's stored position ({pageIndex, rects} in PDF points for highlights), so a reader can draw it."""
    try:
        position = json.loads(raw or "")
    except ValueError:
        return None
    return position if isinstance(position, dict) else None


def item_detail(key: str, full_text: bool = False) -> dict | None:
    """One item, structured for reading: metadata, abstract, notes, highlights (with colour and page), PDFs,
    and optionally the full text. Reads a copy of the database at most a minute old."""
    db = snapshot("reader", max_age=60)
    q = lambda sql, *args: db.execute(sql, args).fetchall()  # noqa: E731
    try:
        row = q("SELECT i.itemID, t.typeName FROM items i JOIN itemTypes t USING(itemTypeID) WHERE i.key=? AND i.libraryID=1", key)
        if not row:
            return None
        item_id, type_name = row[0]
        deleted = {r[0] for r in q("SELECT itemID FROM deletedItems")}
        fields = {name: str(value) for name, value in q(
            """SELECT f.fieldName, v.value FROM itemData d JOIN fields f USING(fieldID) JOIN itemDataValues v USING(valueID)
               WHERE d.itemID=?""", item_id)}
        creators = [{"name": " ".join(p for p in (first, last) if p), "role": role} for first, last, role in q(
            """SELECT c.firstName, c.lastName, ct.creatorType FROM itemCreators ic JOIN creators c USING(creatorID)
               JOIN creatorTypes ct USING(creatorTypeID) WHERE ic.itemID=? ORDER BY ic.orderIndex""", item_id)]
        tags = sorted(name for (name,) in q("SELECT t.name FROM itemTags it JOIN tags t USING(tagID) WHERE it.itemID=?", item_id)
                      if not HOUSEKEEPING_TAG.match(name.strip()))
        collections = sorted(n for (n,) in q(
            "SELECT c.collectionName FROM collectionItems ci JOIN collections c USING(collectionID) WHERE ci.itemID=?", item_id))
        note_rows = [(note_key, _note_text(note)) for note_id, note_key, note in q(
            """SELECT n.itemID, i.key, n.note FROM itemNotes n JOIN items i USING(itemID)
               WHERE n.parentItemID=? ORDER BY n.itemID""", item_id) if note_id not in deleted]
        notes = [text for _, text in note_rows]
        note_keys = [key for key, _ in note_rows]
        attachments = []
        for att_id, att_key, content_type, path, title in q(
                """SELECT a.itemID, i.key, a.contentType, a.path,
                          (SELECT v.value FROM itemData d JOIN fields f USING(fieldID) JOIN itemDataValues v USING(valueID)
                           WHERE d.itemID=a.itemID AND f.fieldName='title')
                   FROM itemAttachments a JOIN items i USING(itemID) WHERE a.parentItemID=?""", item_id):
            if att_id in deleted:
                continue
            highlights = [{"type": ANNOTATION_TYPES.get(kind, "highlight"), "text": (text or "").strip(),
                           "comment": (comment or "").strip(), "color": color or "", "page": page or "",
                           "key": annotation_key, "sort_index": sort_index or "", "position": _position(position)}
                          for annotation_id, kind, text, comment, color, page, sort_index, annotation_key, position in q(
                              """SELECT a.itemID, a.type, a.text, a.comment, a.color, a.pageLabel, a.sortIndex, i.key, a.position
                                 FROM itemAnnotations a JOIN items i USING(itemID)
                                 WHERE a.parentItemID=? ORDER BY a.sortIndex""", att_id)
                          if annotation_id not in deleted and (text or comment or kind == 3) and annotation_key]  # 3: image selection
            cache = ZOTERO / "storage" / att_key / ".zotero-ft-cache"
            entry = {"key": att_key, "title": title or "", "content_type": content_type or "", "highlights": highlights,
                     "has_full_text": cache.is_file(),
                     "open_uri": f"zotero://open-pdf/library/items/{att_key}" if content_type == "application/pdf" else ""}
            if full_text and cache.is_file():
                entry["full_text"] = cache.read_text(encoding="utf-8", errors="replace")
            attachments.append(entry)
        return {
            "key": key, "type": type_name, "title": fields.get("title") or fields.get("shortTitle") or key,
            # dates are stored as "2022-03-00 March 2022": the part after the space is the one people typed
            "creators": creators, "date": fields.get("date", "").split(" ", 1)[-1],
            "year": (re.search(r"\d{4}", fields.get("date", "")) or [""])[0],
            "venue": fields.get("publicationTitle") or fields.get("proceedingsTitle") or fields.get("bookTitle")
                     or fields.get("websiteTitle") or "",
            "volume": fields.get("volume", ""), "issue": fields.get("issue", ""), "pages": fields.get("pages", ""),
            "doi": fields.get("DOI", ""), "url": fields.get("url", ""), "citekey": fields.get("citationKey", ""),
            "abstract": fields.get("abstractNote", ""), "tags": tags, "collections": collections, "notes": notes, "note_keys": note_keys,
            "attachments": attachments, "zotero_uri": f"zotero://select/library/items/{key}",
        }
    finally:
        db.close()
