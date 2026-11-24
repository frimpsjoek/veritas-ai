"""Where a paper's PDF is kept (spec 032).

    target()                       "zotero" when a local Zotero library is found (and the default library is not an
                                   online one), else "folder": Veritas's own papers folder
    keep(paper, url, body=None)    the PDF (downloaded from `url`, or the bytes Browse sent) kept by that rule:
                                     zotero -> pending_adds.attach_pdf: held in data/pdf-inbox/ and attached by the
                                               plugin when Zotero runs (at once, or at its next start)
                                     folder -> <notes folder>/Papers/<First author> <year> - <title>.pdf, with a .json
                                               of what it is beside it; the index reads PDFs in the notes folder
    papers_dir()                   that folder

Nothing writes Zotero's own database or storage: the plugin attaches the file. A copy that cannot be downloaded is
queued for Zotero as a plain add (the plugin then looks for a PDF itself), or reported as failed for the folder.
The same file saved twice is kept once.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import time
import unicodedata
from pathlib import Path

import kb
import paper_text
import pending_adds
import zotero

FOLDER = "Papers"
TITLE_MAX = 90


def target() -> str:
    return "zotero" if zotero.ZOTERO.is_dir() and pending_adds.default_account() is None else "folder"


def papers_dir() -> Path:
    return Path(kb.VAULT) / FOLDER


def _plain(text: str) -> str:
    """A file-name part safe on macOS, Windows and Linux: no separators or reserved characters, no TeX, one space."""
    text = unicodedata.normalize("NFC", str(text or ""))
    text = re.sub(r"\\[a-zA-Z]+\{([^}]*)\}", r"\1", text)  # \textit{GW} -> GW; the $ of $GW$ go below
    text = re.sub(r'[\\/:*?"<>|\x00-\x1f{}$^~]+', " ", text)
    return re.sub(r"\s+", " ", text).strip(" .")


def file_name(paper: dict) -> str:
    """'Chen 2021 - Winter diets of field voles.pdf' (first author's family name, year, title)."""
    authors = paper.get("authors") or []
    first = str(authors[0]) if authors else ""
    family = first.split(",")[0].strip() if "," in first else (first.split()[-1] if first.split() else "")
    year = str(paper.get("year") or "").strip()[:4]
    title = _plain(paper.get("title") or paper.get("doi") or "Untitled")
    if len(title) > TITLE_MAX:
        title = title[:TITLE_MAX].rsplit(" ", 1)[0]
    head = " ".join(p for p in (_plain(family), year) if p)
    return f"{head} - {title}.pdf" if head else f"{title}.pdf"


def _save_to_folder(paper: dict, data: bytes, url: str) -> dict:
    folder = papers_dir()
    folder.mkdir(parents=True, exist_ok=True)
    md5 = hashlib.md5(data).hexdigest()
    for meta in folder.glob("*.json"):
        try:
            if json.loads(meta.read_text()).get("md5") == md5 and meta.with_suffix(".pdf").is_file():
                return {"status": "kept", "where": "folder", "path": f"{FOLDER}/{meta.with_suffix('.pdf').name}", "already": True}
        except (OSError, ValueError):
            continue
    name = file_name(paper)
    path = folder / name
    n = 2
    while path.exists():
        path = folder / f"{name[:-4]} ({n}).pdf"
        n += 1
    with tempfile.NamedTemporaryFile(dir=folder, suffix=".part", delete=False) as tmp:
        tmp.write(data)
    os.replace(tmp.name, path)
    info = {"title": paper.get("title"), "authors": paper.get("authors") or [], "year": paper.get("year"),
            "venue": paper.get("venue"), "doi": pending_adds.norm_doi(paper.get("doi")), "url": url or None,
            "md5": md5, "saved": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    path.with_suffix(".json").write_text(json.dumps(info, ensure_ascii=False, indent=2))
    return {"status": "kept", "where": "folder", "path": f"{FOLDER}/{path.name}"}


def keep(paper: dict, url: str | list | None, body: bytes | None = None, fetch=paper_text.fetch_pdf) -> dict:
    """{status: added | queued | kept | failed, where: zotero | folder, path?, message?, downloaded}. `url` may be a list
    of free copies: each is tried in turn (a publisher may refuse a program; a repository copy usually does not)."""
    paper = paper if isinstance(paper, dict) else {}
    urls = [str(u).strip() for u in (url if isinstance(url, list) else [url]) if str(u or "").strip()][:4]
    url = urls[0] if urls else ""
    where = target()
    data = body
    problem = None
    for candidate in ([] if data is not None else urls):
        try:
            data = fetch(candidate)
            url = candidate
            break
        except (ValueError, OSError) as error:
            problem = str(error)
    if data is not None and not data.startswith(b"%PDF-"):
        data, problem = None, pending_adds.NOT_A_PDF
    if where == "zotero":
        if data is None:
            # no file to hold: the plugin adds the paper and looks for a PDF itself (spec 031 R5)
            result = pending_adds.add_papers([{**paper, **({"pdf": url} if url else {})}])[0]
            return {**result, "where": "zotero", "downloaded": False, **({"message": problem} if problem else {})}
        result = pending_adds.attach_pdf(data, paper.get("doi"), paper.get("title"), url)
        return {**result, "where": "zotero", "downloaded": True}
    if data is None:
        return {"status": "failed", "where": "folder", "downloaded": False, "message": problem or "No PDF to keep"}
    return {**_save_to_folder(paper, data, url), "downloaded": True}
