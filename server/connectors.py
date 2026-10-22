"""The kinds of source Veritas reads, behind one registry (phase 2 task 2).

A connector says how to recognise a folder of its kind and which index stage reads it. sources.py asks the registry
for a folder's kind on every read, in registration order, so a folder holding zotero.sqlite is a Zotero library even
if it also has .obsidian/. Adding a kind is one register() call; search and the apps need no change.

Kinds whose items come from an account rather than a folder (Zotero online) register with a detect that never
matches a path.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

NOTE_EXTENSIONS = (".md", ".markdown", ".txt")
SCAN_LIMIT = 2000  # files looked at to tell a PDF folder from a notes folder; detection runs on every read


@dataclass
class Connector:
    kind: str
    label: str
    detect: Callable[[Path], bool]
    indexed_as: str = ""  # the index stage that reads it: "zotero", "obsidian" or "plain" (default: its own kind)
    writes_notes: bool = False  # can be the output folder Veritas writes notes into
    can_add_items: bool = False  # can receive "+ Add"

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


def register(connector: Connector, *, first: bool = False) -> None:
    """Adds a kind; `first` puts it ahead of the others in detection order."""
    global REGISTRY
    rest = {k: c for k, c in REGISTRY.items() if k != connector.kind}
    REGISTRY = {connector.kind: connector, **rest} if first else {**rest, connector.kind: connector}


def detect(path: Path) -> str:
    """The kind of the folder at `path`, or "missing" when it is not a folder."""
    if not path.is_dir():
        return "missing"
    for connector in REGISTRY.values():
        if connector.detect(path):
            return connector.kind
    return "plain"


def indexed_as(kind: str) -> str:
    """The index stage for a kind ("missing" and unknown kinds stay as they are)."""
    connector = REGISTRY.get(kind)
    return connector.indexed_as if connector else kind


register(Connector("zotero", "Zotero library", lambda p: (p / "zotero.sqlite").is_file(), can_add_items=True))
register(Connector("obsidian", "Obsidian vault", lambda p: (p / ".obsidian").is_dir(), writes_notes=True))
register(Connector("pdf", "PDF folder", _only_pdfs, indexed_as="plain"))
register(Connector("plain", "Notes folder", lambda p: True, writes_notes=True))
# Added by account (user id + API key), not found in a folder: zotero_web.py.
register(Connector("zotero-web", "Zotero online library", lambda p: False, can_add_items=True))
