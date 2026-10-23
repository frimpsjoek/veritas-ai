"""GET /setup/suggest (spec 023 G1): what a new user could add, found on this computer.

{"zotero": item | null, "vaults": [item], "pdf_folders": [item]}, each item {path, display, count, listed}:
the Zotero library (its number of regular items), Obsidian vaults (their Markdown notes) and folders holding at least
MIN_PDFS PDFs directly (the PDF_FOLDERS largest). `listed` says the folder is already in the folder list. The walk
skips hidden folders, Library and node_modules, and stops after MAX_ENTRIES entries, so it answers in about a second.
"""
from __future__ import annotations

import os
import sqlite3
from pathlib import Path

import sources

MIN_PDFS = 5
PDF_FOLDERS = 5
MAX_ENTRIES = 20_000
SKIP = {"Library", "node_modules", "Applications", ".Trash"}
ICLOUD_OBSIDIAN = Path("Library") / "Mobile Documents" / "iCloud~md~obsidian" / "Documents"


def display(path: Path) -> str:
    home = str(Path.home())
    text = str(path)
    return "~" + text[len(home):] if text == home or text.startswith(home + os.sep) else text


def zotero_items(folder: Path) -> int:
    """Regular items in a Zotero library (not notes, attachments, annotations, RSS feed items or the trash); 0 when unreadable.
    Read immutable, so a running Zotero's lock does not matter."""
    try:
        db = sqlite3.connect(f"file:{folder / 'zotero.sqlite'}?mode=ro&immutable=1", uri=True, timeout=1)
        try:
            row = db.execute("""SELECT COUNT(*) FROM items i JOIN itemTypes t USING(itemTypeID) JOIN libraries l USING(libraryID)
                                WHERE t.typeName NOT IN ('attachment', 'note', 'annotation') AND l.type != 'feed'
                                  AND i.itemID NOT IN (SELECT itemID FROM deletedItems)""").fetchone()
        finally:
            db.close()
        return int(row[0]) if row else 0
    except sqlite3.Error:
        return 0


def _walk(root: Path, depth: int, budget: list[int]):
    """(folder, entries) for root and its subfolders down to `depth`, skipping hidden and SKIP folders."""
    if budget[0] <= 0:
        return
    try:
        entries = list(os.scandir(root))
    except OSError:
        return
    budget[0] -= len(entries)
    yield root, entries
    if depth <= 0:
        return
    for entry in entries:
        if budget[0] <= 0:
            return
        name = entry.name
        if name.startswith(".") or name in SKIP:
            continue
        try:
            if entry.is_dir(follow_symlinks=False):
                yield from _walk(Path(entry.path), depth - 1, budget)
        except OSError:
            continue


def _count(folder: Path, suffix: str, cap: int = 20_000) -> int:
    n = 0
    for _, _, files in os.walk(folder):
        n += sum(1 for f in files if f.lower().endswith(suffix))
        if n >= cap:
            break
    return n


def suggest(home: Path | None = None) -> dict:
    home = home or Path.home()
    listed = {str(f.path.resolve()) for f in sources.folders()}
    try:
        output = str(Path(sources.resolved().main).resolve())
    except Exception:  # noqa: BLE001 - no output folder yet: nothing to skip
        output = ""

    def item(path: Path, count: int) -> dict:
        return {"path": str(path), "display": display(path), "count": count, "listed": str(path.resolve()) in listed}

    found = sources.discover_zotero()
    zotero = item(found, zotero_items(found)) if found else None

    vaults: list[dict] = []
    seen: set[str] = set()
    budget = [MAX_ENTRIES]
    roots = [(home / "Documents", 3), (home / ICLOUD_OBSIDIAN, 1), (home, 1)]
    for root, depth in roots:
        if not root.is_dir():
            continue
        for folder, entries in _walk(root, depth, budget):
            if any(e.name == ".obsidian" and e.is_dir() for e in entries) and str(folder) not in seen:
                seen.add(str(folder))
                vaults.append(item(folder, _count(folder, ".md")))

    pdfs: list[dict] = []
    budget = [MAX_ENTRIES]
    for root in (home / "Documents", home / "Downloads", home / "Desktop"):
        if not root.is_dir():
            continue
        for folder, entries in _walk(root, 2, budget):
            n = sum(1 for e in entries if e.name.lower().endswith(".pdf") and e.is_file())
            if n >= MIN_PDFS and str(folder.resolve()) != output and (not found or folder != found):
                pdfs.append(item(folder, n))
    pdfs.sort(key=lambda x: -x["count"])
    return {"zotero": zotero, "vaults": vaults, "pdf_folders": pdfs[:PDF_FOLDERS]}
