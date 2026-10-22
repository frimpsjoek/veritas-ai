"""GET /zotero/pdf?key=<attachmentKey> (spec 013 W2): streams one PDF from Zotero's storage folder.

The file is named by Zotero's own row for the key (storage folder, linked "attachments:<rel>" under the base
directory, or a linked absolute path), never by the request, and its bytes must be a PDF.
No LOCK: streaming a file never waits on search, and search never waits on a download.
"""
from __future__ import annotations

import configparser
import json
import os
import re
import sqlite3
import time
from pathlib import Path
from urllib.parse import quote

import zotero
from web_app import Refused

KEY = re.compile(r"[A-Z0-9]{8}")
CHUNK = 64 * 1024
PROFILES_DIR = Path.home() / "Library" / "Application Support" / "Zotero"
BASE_PREF = re.compile(r'user_pref\("extensions\.zotero\.baseAttachmentPath",\s*"((?:[^"\\]|\\.)*)"\)')
_base_cache: list = []
RANGE = re.compile(r"bytes=(\d*)-(\d*)")
NO_FILE = "no PDF file for this attachment"


class Unsatisfiable(Exception):
    pass


def valid_key(key: str) -> bool:
    return KEY.fullmatch(key) is not None


def attachment_info(key: str) -> tuple[int, str] | None:
    """(linkMode, path) from Zotero's database copy, or None when it has no such attachment or cannot be read."""
    try:
        row = zotero.snapshot("reader", max_age=60).execute(
            "SELECT a.linkMode, a.path FROM itemAttachments a JOIN items i USING(itemID) WHERE i.key=?", (key,)).fetchone()
    except (sqlite3.Error, OSError):
        return None
    return (row[0], row[1] or "") if row else None


def base_dir() -> Path | None:
    """Zotero's "base directory for linked files", from the default profile's prefs.js (cached for a minute)."""
    now = time.monotonic()
    if _base_cache and now - _base_cache[0] < 60:
        return _base_cache[1]
    base = None
    try:
        ini = configparser.ConfigParser()
        ini.read(PROFILES_DIR / "profiles.ini")
        sections = [ini[s] for s in ini.sections() if s.startswith("Profile") and ini[s].get("Path")]
        chosen = next((s for s in sections if s.get("Default") == "1"), sections[0] if len(sections) == 1 else None)
        if chosen:
            profile = PROFILES_DIR / chosen["Path"] if chosen.get("IsRelative", "1") == "1" else Path(chosen["Path"])
            match = BASE_PREF.search((profile / "prefs.js").read_text(errors="replace"))
            base = Path(json.loads(f'"{match.group(1)}"')) if match else None
    except (OSError, configparser.Error, ValueError):
        base = None
    _base_cache[:] = [now, base]
    return base


def _linked(path: str) -> Path:
    """The file a linked-file row names: "attachments:<rel>" under the base directory, else the absolute path."""
    if path.startswith("attachments:"):
        base = base_dir()
        if base is None:
            raise Refused(404, "The linked PDF is not on this Mac (no base directory is set in Zotero)")
        try:
            real_base = base.resolve(strict=True)
            found = (real_base / path.removeprefix("attachments:")).resolve(strict=True)
        except OSError:
            raise Refused(404, f"The linked PDF is not on this Mac (looked in {base})")
        if not found.is_relative_to(real_base):  # ../ in the stored path
            raise Refused(403, "file is outside Zotero's base directory")
        return found
    if not os.path.isabs(path):
        raise Refused(404, "The linked PDF is not on this Mac")
    try:
        return Path(path).resolve(strict=True)
    except OSError:
        raise Refused(404, f"The linked PDF is not on this Mac (looked in {Path(path).parent})")


def _stored(key: str, named: str) -> Path:
    storage = (zotero.ZOTERO / "storage").resolve()
    folder = storage / key
    try:
        if named and "/" not in named and "\\" not in named and (folder / named).is_file():
            candidate = folder / named
        else:
            pdfs = [e.path for e in os.scandir(folder) if e.name.lower().endswith(".pdf") and e.is_file()]
            if len(pdfs) != 1:
                raise Refused(404, NO_FILE)
            candidate = Path(pdfs[0])
        found = candidate.resolve(strict=True)
    except OSError:
        raise Refused(404, NO_FILE)
    if not found.is_relative_to(storage):  # a symlink pointing out of storage
        raise Refused(403, "file is outside Zotero's storage")
    return found


def resolve(key: str) -> Path:
    """The PDF for an attachment key. The path always comes from Zotero's own row for that key, never from the
    request. Raises Refused(status, message) for anything that must not be served."""
    if not valid_key(key):
        raise Refused(400, "key must be an 8-character Zotero attachment key")
    info = attachment_info(key)
    if info and info[0] == 3:  # linked URL
        raise Refused(404, "This attachment is a web link, not a file")
    if info and info[0] == 2:
        found = _linked(info[1])
    else:
        found = _stored(key, (info[1] if info else "").removeprefix("storage:"))
    if found.suffix.lower() != ".pdf":
        raise Refused(415, "only PDF files are served")
    try:
        with open(found, "rb") as f:
            if f.read(5) != b"%PDF-":
                raise Refused(415, "not a PDF file")
    except OSError:
        raise Refused(404, NO_FILE)
    return found


def parse_range(header: str | None, size: int) -> tuple[int, int] | None:
    """(first, last) inclusive for a single satisfiable range; None when there is no usable Range header (serve the
    whole file, as RFC 9110 allows for multi-range or malformed values); raises Unsatisfiable."""
    match = RANGE.fullmatch((header or "").strip())
    if not match:
        return None
    first, last = match.groups()
    if not first and not last:
        return None
    if not first:  # bytes=-n: the last n bytes
        n = int(last)
        if n == 0 or size == 0:
            raise Unsatisfiable
        return max(size - n, 0), size - 1
    start = int(first)
    if start >= size or (last and int(last) < start):
        raise Unsatisfiable
    return start, min(int(last), size - 1) if last else size - 1


def disposition(name: str) -> str:
    ascii_name = re.sub(r'[^\x20-\x7e]|["\\]', "_", name)
    return f"inline; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(name, safe='')}"


def serve(handler, key: str) -> None:
    try:
        path = resolve(key)
    except Refused as refusal:
        return handler._send(refusal.status, {"error": refusal.message})
    stream(handler, path, "application/pdf")


def stream(handler, path: Path, content_type: str) -> None:
    """Streams one file with Range support (also folder PDFs and images, spec 018)."""
    size = 0
    try:
        size = path.stat().st_size
        span = parse_range(handler.headers.get("Range"), size)
    except Refused as refusal:
        return handler._send(refusal.status, {"error": refusal.message})
    except Unsatisfiable:
        handler.send_response(416)
        handler.send_header("Content-Range", f"bytes */{size}")
        handler.send_header("Content-Length", "0")
        return handler.end_headers()
    first, last = span or (0, size - 1)
    length = last - first + 1
    handler.send_response(206 if span else 200)
    handler.send_header("Content-Type", content_type)
    handler.send_header("Accept-Ranges", "bytes")
    handler.send_header("Content-Length", str(length))
    if span:
        handler.send_header("Content-Range", f"bytes {first}-{last}/{size}")
    handler.send_header("Cache-Control", "private, max-age=300")
    handler.send_header("Content-Disposition", disposition(path.name))
    handler.send_header("X-Content-Type-Options", "nosniff")
    handler.end_headers()
    try:
        with open(path, "rb") as f:
            f.seek(first)
            while length > 0:
                chunk = f.read(min(CHUNK, length))
                if not chunk:
                    break
                handler.wfile.write(chunk)
                length -= len(chunk)
    except (BrokenPipeError, ConnectionResetError):  # the viewer closed the tab or seeked elsewhere
        handler.close_connection = True
