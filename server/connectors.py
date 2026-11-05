"""The kinds of source Veritas reads, behind one registry (phase 2 task 2).

A connector says how to recognise a folder of its kind and which index stage reads it. sources.py asks the registry
for a folder's kind when it is first needed, in registration order, so a folder holding zotero.sqlite is a Zotero
library even if it also has .obsidian/. Adding a kind is one register() call; search and the apps need no change.

A connector that must list the folder to recognise it (the PDF folder) says so with `scans`: the answer is kept per
folder until the folder's mtime changes, and a caller that only needs to know zotero / vault / notes / missing asks
with scan=False and never waits on a listing. On 2026-11-03 the desktop app's server hung four times in opendir while
importing kb: every listed folder was walked at import, and a stuck macOS permission prompt for ~/Documents (the
likely cause) held it there, so the server never listened.

Kinds whose items come from an account rather than a folder (Zotero online) register with a detect that never
matches a path.
"""
from __future__ import annotations

import os
import stat
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

NOTE_EXTENSIONS = (".md", ".markdown", ".txt")
SCAN_LIMIT = 2000  # files looked at to tell a PDF folder from a notes folder


@dataclass
class Connector:
    kind: str
    label: str
    detect: Callable[[Path], bool]
    indexed_as: str = ""  # the index stage that reads it: "zotero", "obsidian" or "plain" (default: its own kind)
    writes_notes: bool = False  # can be the output folder Veritas writes notes into
    can_add_items: bool = False  # can receive "+ Add"
    scans: bool = False  # detect lists the folder's files (slow, and the part a stuck permission prompt blocks)

    def __post_init__(self) -> None:
        self.indexed_as = self.indexed_as or self.kind


def _only_pdfs(path: Path) -> bool:
    """A folder of PDFs and no notes (hidden folders skipped), judged on its first SCAN_LIMIT files."""
    seen, pdf = 0, False
    for root, dirs, names in os.walk(path):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for name in names:
            lower = name.lower()
            if lower.endswith(NOTE_EXTENSIONS):
                return False
            pdf = pdf or lower.endswith(".pdf")
            seen += 1
            if seen >= SCAN_LIMIT:
                return pdf
    return pdf


REGISTRY: dict[str, Connector] = {}
_KINDS: dict[str, tuple[int, str]] = {}  # path -> (the folder's mtime_ns when looked at, its kind)


def register(connector: Connector, *, first: bool = False) -> None:
    """Adds a kind; `first` puts it ahead of the others in detection order."""
    global REGISTRY
    rest = {k: c for k, c in REGISTRY.items() if k != connector.kind}
    REGISTRY = {connector.kind: connector, **rest} if first else {**rest, connector.kind: connector}
    _KINDS.clear()  # kinds found before this one was registered may be wrong now


def detect(path: Path, scan: bool = True) -> str:
    """The kind of the folder at `path`, or "missing" when it is not a folder. The answer is kept until the folder's
    mtime changes. With scan=False no connector that lists the folder is asked, so a PDF folder reads as "plain":
    the same index stage, without the walk."""
    try:
        st = path.stat()
    except OSError:
        return "missing"
    if not stat.S_ISDIR(st.st_mode):
        return "missing"
    key = str(path)
    kept = _KINDS.get(key)
    if kept and kept[0] == st.st_mtime_ns:
        return kept[1]
    for connector in REGISTRY.values():
        if connector.scans and not scan:
            continue
        if connector.detect(path):
            if scan:
                _KINDS[key] = (st.st_mtime_ns, connector.kind)
            return connector.kind
    return "plain"


def indexed_as(kind: str) -> str:
    """The index stage for a kind ("missing" and unknown kinds stay as they are)."""
    connector = REGISTRY.get(kind)
    return connector.indexed_as if connector else kind


register(Connector("zotero", "Zotero library", lambda p: (p / "zotero.sqlite").is_file(), can_add_items=True))
register(Connector("obsidian", "Obsidian vault", lambda p: (p / ".obsidian").is_dir(), writes_notes=True))
register(Connector("pdf", "PDF folder", _only_pdfs, indexed_as="plain", scans=True))
register(Connector("plain", "Notes folder", lambda p: True, writes_notes=True))
# Added by account (user id + API key), not found in a folder: zotero_web.py.
register(Connector("zotero-web", "Zotero online library", lambda p: False, can_add_items=True))
