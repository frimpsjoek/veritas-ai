"""Add to Zotero and Read later from hosts that are not Zotero (spec 013 W3).

    add_papers(papers, collection, tag)   per paper {status: added | queued | failed, key?, message?}; to the default
                                          library: an online one directly (Web API), a local one through this queue
    tag_item(key, doi, title, tag)        the same for a tag edit (Read later)
    annotate(key, annotation)             a highlight made in the web reader, for the PDF attachment `key` (spec 014 G3)
    pending()  done(ids)  attempt(id, message)   the queue the Zotero plugin drains

Everything is queued first in data/web/pending-adds.json: [{id, at, kind: add | tag | collection | annotation, paper?,
key?, doi?, title?, collection, tag, annotation?, done, attempts, failed?, message?}]. If Zotero runs, the plugin is then asked to
apply those entries now through its own endpoint; Zotero's connector cannot do this (it saves nothing without a
browser window). Otherwise the plugin applies the queue at its next start or poll. Zotero owns its database, so
nothing here writes zotero.sqlite.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import secrets
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

import web_app

ZOTERO_URL = "http://127.0.0.1:23119"
NAME = "pending-adds.json"
MAX_ATTEMPTS = 5
_lock = threading.Lock()
APPLY_TIMEOUT = 30


def _path() -> Path:
    return web_app.WEB_DIR / NAME


def _load() -> list[dict]:
    try:
        data = json.loads(_path().read_text())
    except (OSError, ValueError):
        return []
    return [e for e in data if isinstance(e, dict) and isinstance(e.get("id"), str)] if isinstance(data, list) else []


def _save(queue: list[dict]) -> None:
    web_app.WEB_DIR.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=web_app.WEB_DIR, prefix=".pending-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(queue, f, ensure_ascii=False)
        os.replace(tmp, _path())
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def norm_title(title: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(title or "").lower()).strip()


def norm_doi(doi: object) -> str:
    return re.sub(r"^(https?://(dx\.)?doi\.org/|doi:)", "", str(doi or "").strip(), flags=re.I).lower()


def _same(entry: dict, doi: str, title: str, key: str | None) -> bool:
    other = entry.get("paper") or entry
    return bool((key and entry.get("key") == key) or (doi and norm_doi(other.get("doi")) == doi)
                or (title and norm_title(other.get("title")) == title))


def _entry(kind: str, **fields) -> dict:
    return {"id": secrets.token_hex(8), "at": int(time.time()), "kind": kind, "done": False, "attempts": 0, **fields}


def _queue_entry(kind: str, **fields) -> str:
    """Appends an entry unless an open one asks for the same thing; returns the id that will carry it out."""
    with _lock:
        queue = _load()
        doi = norm_doi(fields.get("doi") or (fields.get("paper") or {}).get("doi"))
        title = norm_title(fields.get("title") or (fields.get("paper") or {}).get("title"))
        for e in queue:
            if e.get("done") or e.get("failed") or e["kind"] != kind or not _same(e, doi, title, fields.get("key")):
                continue
            if e.get("tag") == fields.get("tag") and e.get("collection") == fields.get("collection"):
                return e["id"]
        entry = _entry(kind, **fields)
        queue.append(entry)
        _save(queue)
        return entry["id"]


def pending() -> list[dict]:
    return [e for e in _load() if not e.get("done") and not e.get("failed")]


def done(ids: object) -> None:
    ids = {i for i in ids if isinstance(i, str)} if isinstance(ids, list) else set()
    with _lock:
        queue = _load()
        if any(e["id"] in ids for e in queue):
            _save([e for e in queue if e["id"] not in ids])


def attempt(entry_id: str, message: str = "") -> dict | None:
    """The plugin could not apply this entry. After MAX_ATTEMPTS it is marked failed and stops being offered."""
    with _lock:
        queue = _load()
        for e in queue:
            if e["id"] == entry_id:
                e["attempts"] = int(e.get("attempts", 0)) + 1
                e["message"] = message[:300]
                if e["attempts"] >= MAX_ATTEMPTS:
                    e["failed"] = True
                _save(queue)
                return e
    return None


# ---------------------------------------------------------------- asking a running Zotero

def zotero_running() -> bool:
    try:
        with urllib.request.urlopen(ZOTERO_URL + "/connector/ping", timeout=1) as res:
            return res.status == 200
    except (OSError, urllib.error.URLError):
        return False


def apply_now(ids: list[str]) -> dict[str, dict]:
    """Asks the running Zotero plugin to apply these entries; {id: {ok, key?, message?}} for those it answered."""
    if not ids or not zotero_running():
        return {}
    request = urllib.request.Request(ZOTERO_URL + "/second-brain/pending-adds/apply", json.dumps({"ids": ids}).encode(),
                                     {"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=APPLY_TIMEOUT) as res:
            results = json.load(res).get("results", [])
    except (OSError, urllib.error.URLError, ValueError, AttributeError):
        return {}  # an older plugin has no such endpoint (404); the entries stay queued for its poll
    return {r["id"]: r for r in results if isinstance(r, dict) and isinstance(r.get("id"), str)}


def _outcome(entry_id: str, applied: dict[str, dict]) -> dict:
    result = applied.get(entry_id)
    if result and result.get("ok"):
        return {"status": "added", "id": entry_id, **({"key": result["key"]} if result.get("key") else {})}
    return {"status": "queued", "id": entry_id}


def default_account():
    """The online library "+ Add" goes to, when the default library is one (else None: the local plugin queue).
    A default online library that is switched off is still returned, so the add says so instead of going elsewhere."""
    import sources
    return next((a for a in sources.accounts() if a.default_library and a.kind == "zotero-web"), None)


def web_item(paper: dict, tag: str | None) -> dict:
    """A Zotero Web API item for a paper as the apps send it ({title, authors, year, doi, abstract, venue, url})."""
    authors = paper.get("authors") or []
    authors = [authors] if isinstance(authors, str) else authors
    item = {"itemType": "preprint" if "arxiv" in str(paper.get("doi") or paper.get("url") or "").lower() else "journalArticle",
            "title": str(paper["title"]).strip(),
            "creators": [{"creatorType": "author", "name": str(a)} for a in authors if str(a).strip()],
            "date": str(paper.get("year") or ""), "DOI": str(paper.get("doi") or ""),
            "abstractNote": str(paper.get("abstract") or ""), "url": str(paper.get("url") or ""),
            "tags": [{"tag": tag}] if tag else []}
    if paper.get("venue"):
        item["publicationTitle" if item["itemType"] == "journalArticle" else "repository"] = str(paper["venue"])
    return item


def _add_online(account, papers: list, tag: str | None) -> list[dict]:
    import zotero_web
    if not account.enabled:
        return [{"status": "failed", "message": f"the default library {account.name} is switched off; switch it on in "
                 "Settings > Folders or pick another default library"} for _ in papers]
    key = zotero_web.get_key(account.user_id)
    if not key:
        return [{"status": "failed", "message": f"no Zotero API key for {account.name}; add it in Settings"} for _ in papers]
    client = zotero_web.Client(account.user_id, key)
    results = []
    for paper in papers:
        if not isinstance(paper, dict) or not str(paper.get("title") or "").strip():
            results.append({"status": "failed", "message": "a paper needs a title"})
            continue
        try:
            results.append({"status": "added", "key": client.create(web_item(paper, tag)), "library": account.name})
        except zotero_web.ZoteroWebError as error:
            results.append({"status": "failed", "message": str(error)})
    return results


def add_papers(papers: list, collection: str | None = None, tag: str | None = None) -> list[dict]:
    collection = collection or None
    tag = (tag or "").strip() or None
    account = default_account()
    if account is not None:  # local collection keys mean nothing online, so `collection` is not sent
        return _add_online(account, papers, tag)
    results: list[dict] = []
    ids = []
    for paper in papers:
        if not isinstance(paper, dict) or not str(paper.get("title") or "").strip():
            results.append({"status": "failed", "message": "a paper needs a title"})
            continue
        entry_id = _queue_entry("add", paper=paper, doi=paper.get("doi"), title=paper["title"], collection=collection, tag=tag)
        ids.append(entry_id)
        results.append({"id": entry_id})
    applied = apply_now(ids)
    return [r if "status" in r else _outcome(r["id"], applied) for r in results]


def tag_item(key: object, doi: object, title: object, tag: object) -> dict:
    tag = str(tag or "").strip()
    key, doi, title = (str(v).strip() if v else None for v in (key, doi, title))
    if not tag or not (key or doi or title):
        raise ValueError("a tag and one of key, doi or title are needed")
    entry_id = _queue_entry("tag", key=key, doi=doi, title=title, collection=None, tag=tag)
    return _outcome(entry_id, apply_now([entry_id]))


# ---------------------------------------------------------------- highlights from the web reader (spec 014 G3)

ZOTERO_KEY = re.compile(r"^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$")
KEY_ALPHABET = "23456789ABCDEFGHIJKLMNPQRSTUVWXYZ"
COLORS = {"#ffd400", "#ff6666", "#5fb236", "#2ea8e5", "#a28ae5", "#e56eee", "#f19837", "#aaaaaa"}  # Zotero's eight
SORT_INDEX = re.compile(r"^\d{5}\|\d{6}\|\d{5}$")
MAX_TEXT = 10_000
MAX_RECTS = 500


def annotation_key(entry_id: str) -> str:
    """The Zotero item key the plugin saves this entry's annotation under: the same on every retry, so a second
    attempt finds the first one's annotation instead of adding another."""
    digest = hashlib.sha256(entry_id.encode()).digest()
    return "".join(KEY_ALPHABET[b % len(KEY_ALPHABET)] for b in digest[:8])


def _rect(value: object) -> list[float]:
    if not isinstance(value, list) or len(value) != 4 or not all(
            isinstance(n, (int, float)) and not isinstance(n, bool) and math.isfinite(n) and abs(n) < 1e6 for n in value):
        raise ValueError("each rect is [x1, y1, x2, y2] in PDF points")
    x1, y1, x2, y2 = (round(float(n), 3) for n in value)
    if x2 < x1 or y2 < y1:
        raise ValueError("a rect's second corner is above and right of its first")
    return [x1, y1, x2, y2]


def parse_annotation(value: object) -> dict:
    """The highlight the web reader sent, checked and reduced to the fields Zotero.Annotations.saveFromJSON reads."""
    if not isinstance(value, dict) or value.get("type") != "highlight":
        raise ValueError("only highlights can be added")
    text, comment = value.get("text"), value.get("comment") or ""
    if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT:
        raise ValueError(f"a highlight needs its text (up to {MAX_TEXT} characters)")
    if not isinstance(comment, str) or len(comment) > MAX_TEXT:
        raise ValueError(f"a comment is up to {MAX_TEXT} characters")
    color = str(value.get("color") or "").lower()
    if color not in COLORS:
        raise ValueError("the colour is one of Zotero's eight")
    position = value.get("position")
    if not isinstance(position, dict):
        raise ValueError("a highlight needs its position")
    page = position.get("pageIndex")
    if not isinstance(page, int) or isinstance(page, bool) or not 0 <= page < 100_000:
        raise ValueError("pageIndex is the page's 0-based number")
    rects = position.get("rects")
    if not isinstance(rects, list) or not 0 < len(rects) <= MAX_RECTS:
        raise ValueError(f"a highlight has 1 to {MAX_RECTS} rects")
    sort_index = value.get("sortIndex")
    if not isinstance(sort_index, str) or not SORT_INDEX.match(sort_index) or int(sort_index[:5]) != page:
        raise ValueError("sortIndex is PPPPP|OOOOOO|TTTTT for the same page")
    label = value.get("pageLabel")
    label = str(label)[:32] if isinstance(label, (str, int)) and str(label).strip() else str(page + 1)
    return {"type": "highlight", "text": text.strip(), "comment": comment.strip(), "color": color, "pageLabel": label,
            "sortIndex": sort_index, "position": {"pageIndex": page, "rects": [_rect(r) for r in rects]}}


def annotate(key: object, annotation: object) -> dict:
    """Queues a highlight for the PDF attachment `key`; {status: added | queued, id, key?} as tag_item answers.
    The same highlight sent twice (a double click, a retry after a dropped reply) is queued once."""
    key = str(key or "").strip()
    if not ZOTERO_KEY.match(key):
        raise ValueError("key is the PDF attachment's Zotero key")
    parsed = parse_annotation(annotation)
    with _lock:
        queue = _load()
        same = next((e for e in queue if e["kind"] == "annotation" and not e.get("done") and not e.get("failed")
                     and e.get("key") == key and {**e.get("annotation", {}), "key": None} == {**parsed, "key": None}), None)
        if same:
            entry_id = same["id"]
        else:
            entry = _entry("annotation", key=key)
            entry["annotation"] = {**parsed, "key": annotation_key(entry["id"])}
            queue.append(entry)
            _save(queue)
            entry_id = entry["id"]
    return _outcome(entry_id, apply_now([entry_id]))
