"""Find the files behind broken Zotero PDF attachments.

Most PDF attachments in the library point at files that are not where Zotero looks: linked files are stored
relative to a base folder that moved to the Content drive, some paths come from a Linux machine, and stored
copies were never synced to this Mac. This module works out, for every PDF attachment, whether its file exists,
where it might be instead (same file name anywhere on the searched drives), and whether that candidate really is
the paper (its first pages contain the title or the DOI). The Zotero plugin applies the plan through Zotero's own
API (relinkAttachmentFile, the base-folder pref, Find Full Text), so the changes sync like any edit made by hand.

Nothing here writes to Zotero or moves a file.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import time
from pathlib import Path

import zotero
import paths

ROOT = Path(__file__).parent
PLAN = paths.data_dir() / "attachment-plan.json"
FILE_LIST = paths.data_dir() / "pdf-files.txt"
HOME = Path.home()
PREFS = next((HOME / "Library/Application Support/Zotero/Profiles").glob("*/prefs.js"), None)
# The linked-files folder as it is on this Mac now; the pref still names the old ~/MEGA/Zotero.
BASE = Path("/Volumes/Content/MEGA/Zotero")
SEARCH_ROOTS = [BASE, Path("/Volumes/Content"), Path("/Volumes/Assets-SSK"), Path("/Volumes/JF_SSD"),
                HOME / "Zotero", HOME / "Documents", HOME / "Downloads", HOME / "Desktop", HOME / "MEGA"]
GENERIC = re.compile(r"^(_|\d+|zotero-\d+|document|download|fulltext|full[-_ ]?text|main|paper|article|pdf|file)"
                     r"( \d+)?\.pdf$", re.I)
STOP = set("with from that this into their between using based over under about after the and for are was were "
           "which through toward towards than when where these those have has its our".split())
MATCH = 0.6  # share of the title's words that must appear on the first pages


def current_base() -> str:
    if PREFS and PREFS.exists():
        m = re.search(r'user_pref\("extensions\.zotero\.baseAttachmentPath", "([^"]*)"\)', PREFS.read_text())
        if m:
            return m.group(1)
    return ""


def pdf_files(max_age: float = 3600) -> dict[str, list[str]]:
    """Every PDF on the searched drives, by lower-case file name. The listing is cached for an hour."""
    if not FILE_LIST.exists() or time.time() - FILE_LIST.stat().st_mtime > max_age:
        roots = [str(r) for r in SEARCH_ROOTS if r.exists()]
        out = subprocess.run(["find", *roots, "-iname", "*.pdf", "-type", "f", "-size", "+1k",
                              "-not", "-path", "*/.Trashes/*", "-not", "-path", "*/.Spotlight-V100/*",
                              "-not", "-path", "*/.Trash/*"], capture_output=True, text=True).stdout
        FILE_LIST.write_text(out)
    by_name: dict[str, list[str]] = {}
    for line in FILE_LIST.read_text().splitlines():
        by_name.setdefault(os.path.basename(line).lower(), [])
        if line not in by_name[os.path.basename(line).lower()]:
            by_name[os.path.basename(line).lower()].append(line)
    return by_name


def resolve(att_key: str, link_mode: int, path: str, base: Path) -> Path | None:
    if not path:
        return None
    if link_mode in (0, 1):  # stored in Zotero's storage folder
        return HOME / "Zotero" / "storage" / att_key / path.removeprefix("storage:")
    if path.startswith("attachments:"):
        return base / path.removeprefix("attachments:")
    return Path(path)


def _real(path: Path) -> bool:
    """Exists and is not one of the empty placeholder files left in ~/MEGA/Zotero."""
    try:
        return path.stat().st_size > 1024
    except OSError:
        return False


def _is_pdf(path: str) -> bool:
    """A real PDF, not a cloud placeholder (never-downloaded OneDrive files read as zeros)."""
    try:
        with open(path, "rb") as f:
            return f.read(5) == b"%PDF-"
    except OSError:
        return False


def words(text: str) -> set[str]:
    return {w for w in re.findall(r"[a-z0-9]+", text.lower()) if len(w) > 3 and w not in STOP}


def first_pages(path: str, pages: int = 2) -> str:
    import pypdfium2 as pdfium
    try:
        pdf = pdfium.PdfDocument(path)
        try:
            return " ".join(pdf[i].get_textpage().get_text_range() for i in range(min(pages, len(pdf))))
        finally:
            pdf.close()
    except Exception:
        return ""


def score(candidate: str, title: str, doi: str) -> float | None:
    """1.0 when the DOI is printed on the first pages, else the share of title words found there; None when
    the PDF has no text layer to check against."""
    text = first_pages(candidate)
    if len(text.strip()) < 50:
        return None
    flat = re.sub(r"\s+", "", text.lower())
    if doi and doi.lower().replace(" ", "") in flat:
        return 1.0
    want = words(title)
    if not want:
        return None
    return len(want & words(text)) / len(want)


def plan(progress=None) -> dict:
    """What the plugin should do: the base folder to set, attachments to relink (with the matched file) and
    papers that still have no working PDF (for Find Full Text)."""
    db = zotero.snapshot("files")
    q = lambda sql, *a: db.execute(sql, a).fetchall()  # noqa: E731
    deleted = {r[0] for r in q("SELECT itemID FROM deletedItems")}
    fields: dict[int, dict[str, str]] = {}
    for item_id, name, value in q("""SELECT d.itemID, f.fieldName, v.value FROM itemData d JOIN fields f USING(fieldID)
                                     JOIN itemDataValues v USING(valueID) WHERE f.fieldName IN ('title', 'DOI')"""):
        fields.setdefault(item_id, {})[name] = str(value)
    parents = {item_id: key for item_id, key, kind in q(
        """SELECT i.itemID, i.key, t.typeName FROM items i JOIN itemTypes t USING(itemTypeID) WHERE i.libraryID = 1""")
        if kind not in ("attachment", "note", "annotation") and item_id not in deleted}
    attachments = [r for r in q("""SELECT a.itemID, i.key, a.parentItemID, a.linkMode, a.path FROM itemAttachments a
                                   JOIN items i USING(itemID) WHERE i.libraryID = 1
                                   AND a.contentType = 'application/pdf'""") if r[0] not in deleted]
    annotated = {r[0] for r in q("SELECT DISTINCT parentItemID FROM itemAnnotations")}
    db.close()

    base = BASE if BASE.exists() else Path(current_base())
    by_name = pdf_files()
    working: set[int] = set()
    relink, unresolved = [], []
    counts = {"pdf_attachments": len(attachments), "ok": 0, "ok_after_base": 0, "relink": 0, "not_found": 0,
              "unverified": 0}
    old_base = Path(current_base()) if current_base() else None
    for n, (att_id, att_key, parent, mode, path) in enumerate(attachments):
        if progress and n % 50 == 0:
            progress(n, len(attachments))
        if mode == 3:  # linked URL, nothing to relink
            continue
        now = resolve(att_key, mode, path or "", old_base or base)
        if now and _real(now):
            counts["ok"] += 1
            working.add(parent)
            continue
        target = resolve(att_key, mode, path or "", base)
        if target and _real(target):
            counts["ok_after_base"] += 1
            working.add(parent)
            continue
        name = os.path.basename(path or "").lower()
        candidates = [c for c in by_name.get(name, []) if not c.startswith(str(HOME / "MEGA"))]
        info = fields.get(parent, {})
        title, doi = info.get("title", ""), info.get("DOI", "")
        best, best_score = None, 0.0
        # Files in the Zotero folder on the Content drive first: that is where these PDFs live now.
        for candidate in sorted(candidates, key=lambda c: (not c.startswith(str(base)), c))[:6]:
            s = score(candidate, title, doi)
            if s is None:
                if (len(candidates) == 1 and not GENERIC.match(name) and "/Zotero/" in candidate
                        and _is_pdf(candidate)):
                    best, best_score = candidate, 0.0
                    counts["unverified"] += 1
                    break
                continue
            if s >= MATCH and s > best_score:
                best, best_score = candidate, s
                if s == 1.0:
                    break
        if best:
            counts["relink"] += 1
            working.add(parent)
            relink.append({"attachment": att_key, "parent": parents.get(parent, ""), "path": best,
                           "score": round(best_score, 2), "annotated": att_id in annotated})
        else:
            counts["not_found"] += 1
            unresolved.append(att_key)
    without = sorted(key for item_id, key in parents.items() if item_id not in working)
    counts["papers"] = len(parents)
    counts["papers_without_pdf"] = len(without)
    result = {"created_at": time.time(), "base": str(base), "old_base": str(old_base or ""), "counts": counts,
              "relink": relink, "broken": unresolved, "find_online": without}
    PLAN.write_text(json.dumps(result))
    return result


def cached_plan(max_age: float = 600) -> dict:
    if PLAN.exists() and time.time() - PLAN.stat().st_mtime < max_age:
        return json.loads(PLAN.read_text())
    return plan()


if __name__ == "__main__":
    import sys
    t = time.time()
    p = plan(lambda n, total: print(f"\r{n}/{total}", end="", file=sys.stderr))
    print(file=sys.stderr)
    print(json.dumps(p["counts"], indent=1), f"{time.time() - t:.0f} s")
