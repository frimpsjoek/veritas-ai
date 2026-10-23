"""Paper notes: one Obsidian note per Zotero paper, linked both ways.

A paper note lives in Papers/ and is found again by its `zotero-key` front matter, so it can be renamed or moved.
It has two parts:
- "My notes", written in Obsidian and never touched by this code;
- a block between ZOTERO_START and ZOTERO_END with the abstract, the PDF highlights (each links to its spot in
  the PDF) and the notes written in Zotero. It is rewritten whenever the paper changes in Zotero, and it syncs
  back too: a highlight's comment or a Zotero note edited here is queued (pending_edits) and the Zotero plugin
  writes it into Zotero. Edits are found by comparing the block with what was last written (BASELINES), so a
  change made in Zotero is never mistaken for one made in Obsidian. The abstract and highlighted text belong
  to the paper and stay one-way.
The note cites the paper as [@citekey], which is how the index links it to the paper ("Cited in your notes").

"My notes" can also be edited from Zotero (body/save below). A save names the version it started from (a hash of
the section); if the note changed in Obsidian meanwhile, the save is refused and the editor shows both. Papers
cited in "My notes" as [@citekey] (or @citekey inside brackets) are listed under References in the Zotero block,
so the references are kept up to date whichever side the note was written in.
"""
from __future__ import annotations

import base64
import hashlib
import html
import json
import os
import re
import shutil
import threading
import time
from pathlib import Path

import zotero
import paths

FOLDER = "Papers"
ATTACHMENTS = "Papers/attachments"  # pasted images and image highlights
IMAGE_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
               ".webp": "image/webp", ".svg": "image/svg+xml", ".bmp": "image/bmp"}
ZOTERO_CACHE = Path.home() / "Zotero" / "cache" / "library"
# Obsidian comments (%% %%), so the markers don't show when reading. Older notes used <!-- --> markers.
ZOTERO_START = "%% zotero:start · synced with Zotero both ways: edit comments and Zotero notes here %%"
ZOTERO_END = "%% zotero:end %%"
NOTE_MARK = re.compile(r"^%% zotero-note ([A-Z0-9]{8}) %%$", re.M)
HIGHLIGHT_LINK = re.compile(r"\?annotation=([A-Z0-9]{8})\)\)\s*$")
COMMENT_LINE = re.compile(r"^\s+- \*\*Comment:\*\*\s?(.*)$")
EDITS = paths.data_dir() / "zotero-edits.json"  # waiting for the Zotero plugin
BASELINES = paths.data_dir() / "paper-blocks.json"  # what each note's block said when written
# Everything from the "My notes" heading to the Zotero block is the user's, subheadings included.
CITATION = re.compile(r"\[([^\[\]]*@[^\[\]]+)\]")
CITEKEY = re.compile(r"@([\w:.#$%&+?<>~/-]+)")
PLACEHOLDER = "*Write here. This part is yours and is never overwritten.*"
# One writer at a time: a refresh from Zotero, a save from the editor and the indexer can all touch one note.
WRITE_LOCK = threading.RLock()
COLORS = {"#ffd400": "🟨", "#ff6666": "🟥", "#5fb236": "🟩", "#2ea8e5": "🟦", "#a28ae5": "🟪", "#e56eee": "🟪",
          "#f19837": "🟧", "#aaaaaa": "⬜"}


START_LINE = re.compile(r"^(?:<!--|%%) zotero:start\b[^\n]*$", re.M)
END_LINE = re.compile(r"^(?:<!--|%%) zotero:end (?:-->|%%)[ \t]*$", re.M)
MY_NOTES_HEADING = re.compile(r"^## My notes[ \t]*$", re.M)


def normalize(text: str) -> str:
    """Notes are handled with \n line ends; a note saved with Windows line ends reads the same."""
    return text.replace("\r\n", "\n")


def block_span(text: str) -> tuple[int, int] | None:
    """Where the Zotero block is: from the LAST start marker that has an end marker after it. The block is always
    written at the end of the note, so a marker quoted earlier (in My notes, a code fence) is never taken for it."""
    for start in reversed(list(START_LINE.finditer(text))):
        end = END_LINE.search(text, start.end())
        if end:
            return start.start(), end.end()
    return None


def _read(path: Path) -> str:
    return normalize(path.read_text(encoding="utf-8", errors="replace"))


def _vault() -> Path:
    import kb
    return kb.VAULT


def find(key: str, thorough: bool = False) -> str | None:
    """Vault-relative path of the paper's note, or None. Looks in Papers/ first, then the index; thorough also
    reads the front matter of every note in the vault (used before making a note, so a note the user moved out
    of Papers/ since the last index run isn't duplicated)."""
    folder = _vault() / FOLDER
    pattern = re.compile(rf"^zotero-key:\s*\"?{re.escape(key)}\"?\s*$", re.M)
    if folder.is_dir():
        for path in folder.rglob("*.md"):
            try:
                head = path.read_text(encoding="utf-8", errors="replace")[:2000]
            except OSError:
                continue
            if pattern.search(head):
                return str(path.relative_to(_vault()))
    import kb
    db = kb.connect()
    try:
        row = db.execute("SELECT path FROM notes WHERE frontmatter LIKE ? LIMIT 1", (f'%"zotero-key": "{key}"%',)).fetchone()
    finally:
        db.close()
    if row and (_vault() / row[0]).exists():
        return row[0]
    if thorough:
        for path in _vault().rglob("*.md"):
            if any(part.startswith(".") for part in path.relative_to(_vault()).parts):
                continue
            try:
                with open(path, encoding="utf-8", errors="replace") as f:
                    head = f.read(2000)
            except OSError:
                continue
            if head.startswith("---") and pattern.search(head):
                return str(path.relative_to(_vault()))
    return None


def _file_name(detail: dict) -> str:
    title = re.sub(r"<[^>]+>", "", detail["title"])
    title = re.sub(r'[\\/:*?"<>|#^\[\]]', " ", title)
    title = re.sub(r"\s+", " ", title).strip()[:80].rstrip(" .")
    cite = detail.get("citekey") or detail["key"]
    return f"{cite} {title}".strip() + ".md"


def _yaml(value: str) -> str:
    return '"' + str(value).replace("\\", "\\\\").replace('"', '\\"') + '"'


def _annotation_image(key: str) -> str | None:
    """Copy an image highlight from Zotero's cache into the vault; returns its file name for ![[...]]."""
    source = ZOTERO_CACHE / f"{key}.png"
    if not source.exists():
        return None
    name = f"zotero-{key}.png"
    target = _vault() / ATTACHMENTS / name
    if not target.exists() or target.stat().st_mtime < source.stat().st_mtime:
        target.parent.mkdir(parents=True, exist_ok=True)
        # Zotero's renderer draws some vector figures (e.g. chemical structures) as a blank picture; draw the
        # selected area from the PDF instead. A later, non-blank picture from Zotero (newer file) replaces it.
        if _blank(source) and _render_annotation(key, target):
            return name
        shutil.copy2(source, target)
    return name


def _blank(path: Path) -> bool:
    try:
        from PIL import Image

        with Image.open(path) as image:
            low, high = image.convert("L").getextrema()
        return low == high
    except Exception:  # noqa: BLE001 - an unreadable picture isn't treated as blank
        return False


def _render_annotation(key: str, target: Path) -> bool:
    """Draw an image highlight's area from its PDF at Zotero's size (4x), into target. False if it can't."""
    db = zotero.snapshot("reader", max_age=60)
    try:
        row = db.execute(
            """SELECT a.position, att.path, ai.key FROM itemAnnotations a JOIN items i ON i.itemID = a.itemID
               JOIN itemAttachments att ON att.itemID = a.parentItemID JOIN items ai ON ai.itemID = att.itemID
               WHERE i.key = ?""", (key,)).fetchone()
    finally:
        db.close()
    if not row or not row[1]:
        return False
    position, stored, attachment = json.loads(row[0]), row[1], row[2]
    pdf_path = zotero.root() / "storage" / attachment / stored[8:] if stored.startswith("storage:") else Path(stored)
    rects = position.get("rects") or []
    if not pdf_path.is_file() or not rects or "pageIndex" not in position:
        return False
    try:
        import media
        import pypdfium2 as pdfium

        x0, y0 = min(r[0] for r in rects), min(r[1] for r in rects)
        x1, y1 = max(r[2] for r in rects), max(r[3] for r in rects)
        scale = 4
        with media._PDFIUM_LOCK:
            pdf = pdfium.PdfDocument(str(pdf_path))
            try:
                page = pdf[position["pageIndex"]]
                height = page.get_size()[1]
                image = page.render(scale=scale).to_pil().convert("RGB")
            finally:
                pdf.close()
        image.crop((int(x0 * scale), int((height - y1) * scale), int(x1 * scale), int((height - y0) * scale))).save(target)
        return True
    except Exception as error:  # noqa: BLE001 - fall back to Zotero's picture
        print(f"render annotation {key}: {error}", file=__import__("sys").stderr)
        return False


def ensure_images(text: str) -> int:
    """Copy every image highlight the note embeds (![[zotero-KEY.png]]) from Zotero's cache into the vault.
    Zotero draws an image selection a moment after it is made, so this runs on every save and refresh."""
    return sum(1 for key in set(re.findall(r"zotero-([A-Z0-9]{8})\.png", text)) if _annotation_image(key))


_images: dict = {"at": 0.0, "by_name": {}}


def image_file(name: str | None = None, path: str | None = None, note: str | None = None) -> Path | None:
    """An image in the vault: by Obsidian embed name (![[name]]), or by a path relative to the vault or to
    the note. Only image files inside the vault are returned."""
    vault = _vault().resolve()
    candidates = []
    roots = [vault]
    if path:
        if note and ":/" in note:
            # a note in a listed folder (spec 018, "papers:/review.md"): its images are beside it in that folder
            import kb  # imported here, as elsewhere in this module: kb imports paper_notes
            top, _, inner = kb.split_prefixed(note)
            roots.append(top.resolve())
            candidates.append(top / Path(inner).parent / path)
        elif note:
            candidates.append(vault / Path(note).parent / path)
        candidates.append(vault / path)
    if name:
        m = re.fullmatch(r"zotero-([A-Z0-9]{8})\.png", os.path.basename(name))
        if m:
            _annotation_image(m.group(1))
        candidates.append(vault / ATTACHMENTS / name)
        if time.time() - _images["at"] > 300:
            import media
            by_name: dict[str, str] = {}
            for rel in media.media_files(vault):
                by_name.setdefault(os.path.basename(rel).lower(), rel)
            _images.update(at=time.time(), by_name=by_name)
        rel = _images["by_name"].get(os.path.basename(name).lower())
        if rel:
            candidates.append(vault / rel)
    for candidate in candidates:
        try:
            resolved = candidate.resolve()
        except OSError:
            continue
        if resolved.is_file() and any(resolved.is_relative_to(root) for root in roots) and resolved.suffix.lower() in IMAGE_TYPES:
            return resolved
    return None


def save_image(name: str, data_b64: str) -> str:
    """A pasted or dropped image, saved into Papers/attachments; returns the name to embed."""
    data = base64.b64decode(data_b64)
    if len(data) > 25 * 1024 * 1024:
        raise ValueError("image is larger than 25 MB")
    stem, ext = os.path.splitext(os.path.basename(name or "image.png"))
    ext = ext.lower() if ext.lower() in IMAGE_TYPES else ".png"
    stem = re.sub(r"[^\w.-]+", "-", stem).strip("-")[:60] or "image"
    final = f"{time.strftime('%Y%m%d-%H%M%S')}-{stem}{ext}"
    target = _vault() / ATTACHMENTS / final
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    _images["at"] = 0.0
    return final


def cited(text: str) -> list[str]:
    """Citekeys cited in text, in order of first use: [@a], [@a; @b, p. 4], [see @a]."""
    keys: list[str] = []
    for group in CITATION.findall(text):
        for key in CITEKEY.findall(group):
            key = key.rstrip(".,;:")
            if key not in keys:
                keys.append(key)
    return keys


def lookup(keys: list[str]) -> dict[str, dict]:
    """Citekey (or 8-character Zotero key) -> {key, title, meta} for the papers in the index."""
    if not keys:
        return {}
    import kb
    db = kb.connect()
    try:
        rows = db.execute("SELECT path, title, meta FROM notes WHERE source = 'zotero'").fetchall()
    finally:
        db.close()
    wanted, found = set(keys), {}
    for path, title, meta in rows:
        m = json.loads(meta or "{}")
        key = path.removeprefix(zotero.PREFIX)
        for name in (m.get("citekey"), key):
            if name in wanted and name not in found:
                found[name] = {"key": key, "title": title, "meta": m}
    return found


def _reference(entry: dict) -> str:
    m = entry["meta"]
    authors = m.get("authors", [])
    names = ", ".join(a.split(" ")[-1] for a in authors[:3]) + (" et al." if len(authors) > 3 else "")
    parts = [p for p in (names, f"({m['year']})" if m.get("year") else "") if p]
    lead = " ".join(parts)
    venue = f" {m['venue']}." if m.get("venue") else ""
    return (f"{lead + '. ' if lead else ''}*{re.sub(r'<[^>]+>', '', entry['title'])}*.{venue} "
            f"[Zotero](zotero://select/library/items/{entry['key']})")


def _block(detail: dict, my_notes: str = "", overlay: dict | None = None) -> str:
    """The Zotero part of a paper note. overlay: edits made in Obsidian that Zotero hasn't applied yet, shown in
    place of Zotero's current text so a refresh doesn't undo them."""
    overlay = overlay or {"comments": {}, "notes": {}}
    lines = [ZOTERO_START]
    if detail.get("abstract"):
        lines += ["## Abstract", "", detail["abstract"].strip(), ""]
    highlights = []
    for attachment in detail.get("attachments", []):
        for h in attachment.get("highlights", []):
            link = f"zotero://open-pdf/library/items/{attachment['key']}?annotation={h['key']}"
            page = f"p. {h['page']}" if h.get("page") else "open"
            mark = COLORS.get((h.get("color") or "").lower(), "")
            text = " ".join(h["text"].split())
            if h.get("type") == "image":
                image = _annotation_image(h["key"])
                text = f"![[{image}]]" if image else "*(image selection; open the PDF once in Zotero to copy it here)*"
            entry = f"- {mark + ' ' if mark else ''}{text} ([{page}]({link}))" if text else f"- ([{page}]({link}))"
            comment = overlay["comments"].get(h["key"], h.get("comment") or "")
            if comment:
                lines_ = [" ".join(line.split()) for line in comment.splitlines() if line.strip()]
                entry += f"\n  - **Comment:** {lines_[0]}" + "".join(f"\n    {line}" for line in lines_[1:])
            highlights.append(entry)
    if highlights:
        lines += ["## Highlights", "", *highlights, ""]
    notes = [(k, overlay["notes"].get(k, n).strip())
             for k, n in zip(detail.get("note_keys", []), detail.get("notes", []))]
    notes = [(k, n) for k, n in notes if n]
    if notes:
        lines += ["## Notes from Zotero", ""]
        for k, n in notes:
            lines += [f"%% zotero-note {k} %%", n, ""]
    keys = [k for k in cited(my_notes) if k not in (detail.get("citekey"), detail["key"])]
    if keys:
        known = lookup(keys)
        lines += ["## References", ""]
        for k in keys:
            lines.append(f"- [@{k}] " + (_reference(known[k]) if k in known else "*not found in your Zotero library*"))
        lines.append("")
    if len(lines) == 1:
        lines += ["*No abstract, highlights or Zotero notes yet.*", ""]
    lines.append(ZOTERO_END)
    return "\n".join(lines)


def _render(detail: dict) -> str:
    authors = [c["name"] if isinstance(c, dict) else str(c) for c in detail.get("creators", [])]
    cite = detail.get("citekey") or detail["key"]
    pdf = next((a for a in detail.get("attachments", []) if a.get("content_type") == "application/pdf"), None)
    links = [f"[Open in Zotero]({detail['zotero_uri']})"]
    if pdf:
        links.append(f"[Open PDF](zotero://open-pdf/library/items/{pdf['key']})")
    if detail.get("doi"):
        links.append(f"[DOI](https://doi.org/{detail['doi']})")
    byline = " · ".join(p for p in (", ".join(authors[:4]) + (" et al." if len(authors) > 4 else ""),
                                     detail.get("year", ""), detail.get("venue", "")) if p)
    front = ["---", f"title: {_yaml(re.sub(r'<[^>]+>', '', detail['title']))}",
             "authors: [" + ", ".join(_yaml(a) for a in authors[:12]) + "]",
             f"year: {_yaml(detail.get('year', ''))}", f"citekey: {_yaml(cite)}",
             f"doi: {_yaml(detail.get('doi', ''))}", f"zotero-key: {detail['key']}",
             f"zotero: {_yaml(detail['zotero_uri'])}", "tags: [paper]", "---"]
    return "\n".join(front + ["", f"# {re.sub(r'<[^>]+>', '', detail['title'])}", "",
                              f"[@{cite}] · {byline}" if byline else f"[@{cite}]", "", " · ".join(links), "",
                              "## My notes", "", PLACEHOLDER, "", _block(detail), ""])


def create(key: str) -> dict:
    """The paper's note, made if it does not exist yet (and its Zotero part refreshed if it does)."""
    with WRITE_LOCK:
        return _create_locked(key)


def _create_locked(key: str) -> dict:
    existing = find(key, thorough=True)
    if existing:
        refresh(key, existing)
        return {"path": existing, "created": False}
    detail = zotero.item_detail(key)
    if detail is None:
        raise FileNotFoundError(f"no Zotero item {key!r}")
    folder = _vault() / FOLDER
    folder.mkdir(exist_ok=True)
    path = folder / _file_name(detail)
    n = 2
    while path.exists():
        path = folder / _file_name(detail).replace(".md", f" {n}.md")
        n += 1
    content = _render(detail)
    path.write_text(content, encoding="utf-8")
    _remember(key, parse_block(content))
    return {"path": str(path.relative_to(_vault())), "created": True}


def refresh(key: str, rel: str | None = None, fresh: bool = False) -> bool:
    """Rewrite the Zotero block of an existing note. Returns whether the file changed. fresh: read Zotero now
    (after a highlight was just made) rather than a copy up to a minute old."""
    with WRITE_LOCK:
        return _refresh_locked(key, rel, fresh)


def _refresh_locked(key: str, rel: str | None = None, fresh: bool = False) -> bool:
    rel = rel or find(key)
    if not rel:
        return False
    if fresh:
        zotero.snapshot("reader").close()
    path = _vault() / rel
    text = _read(path)
    detail = zotero.item_detail(key)
    if detail is None:
        return False
    ensure_images(text)
    queue_edits(key, rel, text)  # anything changed in Obsidian goes to Zotero before the block is rewritten
    block = _block(detail, _section(text)[0], _overlay(key))
    _remember(key, parse_block(block))
    span = block_span(text)
    new = text[:span[0]] + block + text[span[1]:] if span else text.rstrip() + "\n\n" + block + "\n"
    if new == text:
        return False
    path.write_text(new, encoding="utf-8")
    return True


# ---------------------------------------------------------------- Obsidian -> Zotero

def parse_block(text: str) -> dict:
    """Highlight comments (by annotation key) and Zotero notes (by note key) as they read in a note's block."""
    span = block_span(normalize(text))
    if not span:
        return {"comments": {}, "notes": {}}
    block = normalize(text)[span[0]:span[1]]
    comments: dict[str, str] = {}
    lines = block.split("\n")
    for i, line in enumerate(lines):
        hit = HIGHLIGHT_LINK.search(line)
        if not hit:
            continue
        # The comment is whatever is indented under the highlight, however it was reformatted: "  - **Comment:**
        # x", "  - x", "  x". Only a highlight with nothing indented under it counts as having no comment.
        body = []
        for follow in lines[i + 1:]:
            if not follow.strip() or not follow[:1].isspace():
                break
            text = re.sub(r"^\s*(?:[-*+]\s+)?(?:\*\*|__)?comment:?(?:\*\*|__)?:?\s*", "", follow, flags=re.I)
            body.append(text.strip() if text != follow else follow.strip().lstrip("-*+ ").strip())
        comments[hit.group(1)] = "\n".join(t for t in body if t)
    notes: dict[str, str] = {}
    marks = list(NOTE_MARK.finditer(block))
    for n, mark in enumerate(marks):
        end = marks[n + 1].start() if n + 1 < len(marks) else len(block)
        body = block[mark.end():end]
        # A note runs to the next note, the References list or the block's end, so headings the user adds
        # inside a note stay part of it.
        body = re.split(r"^## References[ \t]*$|^%% zotero:end", body, maxsplit=1, flags=re.M)[0]
        notes[mark.group(1)] = body.strip()
    return {"comments": comments, "notes": notes}


def _load(path: Path) -> dict | list:
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return {} if path is BASELINES else []


def _remember(key: str, parsed: dict) -> None:
    baselines = _load(BASELINES)
    baselines[key] = parsed
    BASELINES.write_text(json.dumps(baselines))


def _overlay(key: str) -> dict:
    overlay = {"comments": {}, "notes": {}}
    for edit in _load(EDITS):
        if edit["paper"] == key:
            overlay["comments" if edit["kind"] == "comment" else "notes"][edit["key"]] = edit["value"]
    return overlay


def queue_edits(key: str, rel: str, text: str | None = None) -> int:
    """Compare the note's block with what was last written; queue each comment or Zotero note the user changed."""
    base = _load(BASELINES).get(key)
    if base is None:
        return 0
    text = normalize(text) if text is not None else _read(_vault() / rel)
    now = parse_block(text)
    queue = [e for e in _load(EDITS)]
    added = 0

    def put(kind: str, target: str, value: str) -> None:
        nonlocal added
        queue[:] = [e for e in queue if not (e["kind"] == kind and e["key"] == target)]
        item = {"id": f"{kind}:{target}:{int(time.time() * 1000)}", "paper": key, "kind": kind, "key": target, "value": value}
        if kind == "note":
            import markdown
            # raw HTML in the note is shown as text in Zotero, not written into it as markup
            item["html"] = markdown.markdown(value.replace("&", "&amp;").replace("<", "&lt;"), extensions=["extra", "sane_lists"])
        queue.append(item)
        added += 1

    # A highlight or note added in Zotero since the block was last written isn't in the baseline yet; compare
    # those with Zotero itself, so a comment typed on them in Obsidian isn't ignored.
    unknown = [t for t in now["comments"] if t not in base["comments"]] + [t for t in now["notes"] if t not in base["notes"]]
    if unknown:
        detail = zotero.item_detail(key) or {}
        current = parse_block(_block(detail)) if detail else {"comments": {}, "notes": {}}
        base = {"comments": {**current["comments"], **base["comments"]}, "notes": {**current["notes"], **base["notes"]}}
    for target, value in now["comments"].items():
        if target in base["comments"] and value != base["comments"][target]:
            put("comment", target, value)
    for target, value in now["notes"].items():
        if target in base["notes"] and value != base["notes"][target]:
            put("note", target, value)
    if added:
        EDITS.write_text(json.dumps(queue))
    return added


_scan = {"at": 0.0}


def pending_edits() -> list[dict]:
    """Edits made in Obsidian since the last look, for the Zotero plugin to apply."""
    folder = _vault() / FOLDER
    started = time.time()
    with WRITE_LOCK:
        return _pending_edits_locked(folder, started)


def _pending_edits_locked(folder: Path, started: float) -> list[dict]:
    if folder.is_dir():
        for path in folder.rglob("*.md"):
            try:
                if path.stat().st_mtime <= _scan["at"]:
                    continue
                head = _read(path)
            except OSError:
                continue
            m = re.search(r"^zotero-key:\s*\"?([A-Z0-9]{8})\"?\s*$", head[:2000], re.M)
            if m:
                queue_edits(m.group(1), str(path.relative_to(_vault())), head)
    _scan["at"] = started - 1
    return _load(EDITS)


def edits_done(ids: list[str]) -> None:
    """The plugin wrote these into Zotero: drop them, and refresh those papers' notes from Zotero."""
    with WRITE_LOCK:
        return _edits_done_locked(ids)


def _edits_done_locked(ids: list[str]) -> None:
    queue = _load(EDITS)
    papers = {e["paper"] for e in queue if e["id"] in ids}
    # an id whose edit was replaced by a newer one (same kind:target) still names its paper through the baseline
    targets = {i.split(":")[1] for i in ids if i.count(":") >= 2}
    for paper, base in _load(BASELINES).items():
        if targets & (set(base.get("comments", {})) | set(base.get("notes", {}))):
            papers.add(paper)
    EDITS.write_text(json.dumps([e for e in queue if e["id"] not in ids]))
    for key in papers:
        refresh(key, fresh=True)


def _section(text: str) -> tuple[str, tuple[int, int] | None]:
    """The "My notes" text and where it sits (start, end) in the note, or ("", None) without the heading."""
    span = block_span(text)
    limit = span[0] if span else len(text)
    heading = None
    for m in MY_NOTES_HEADING.finditer(text, 0, limit):
        heading = m
        break
    if not heading:
        return "", None
    start = heading.end() + 1 if text[heading.end():heading.end() + 1] == "\n" else heading.end()
    mine = text[start:limit].strip("\n")
    return ("" if mine.strip() == PLACEHOLDER else mine), (start, limit)


def _hash(text: str) -> str:
    return hashlib.sha1(text.strip().encode()).hexdigest()[:16]


def summary(key: str) -> dict:
    """For Zotero's item pane: whether the paper has a note, and what the "My notes" part says."""
    rel = find(key)
    if not rel:
        return {"path": None}
    mine = _section(_read(_vault() / rel))[0].strip()
    return {"path": rel, "title": Path(rel).stem, "my_notes": mine[:1500], "words": len(mine.split())}


def references(text: str, own: tuple[str, ...] = ()) -> list[dict]:
    """The papers text cites, for the editor's References list."""
    keys = [k for k in cited(text) if k not in own]
    known = lookup(keys)
    out = []
    for k in keys:
        entry = known.get(k)
        if not entry:
            out.append({"citekey": k, "key": None})
            continue
        authors = entry["meta"].get("authors", [])
        who = authors[0].split(" ")[-1] + (" et al." if len(authors) > 2 else f" & {authors[1].split(' ')[-1]}"
                                             if len(authors) == 2 else "") if authors else ""
        out.append({"citekey": k, "key": entry["key"], "title": re.sub(r"<[^>]+>", "", entry["title"]),
                    "label": " ".join(p for p in (who, entry["meta"].get("year", "")) if p),
                    "venue": entry["meta"].get("venue", "")})
    return out


def body(key: str) -> dict:
    """The whole "My notes" section, for the editor in Zotero, with the hash a save must quote."""
    rel = find(key)
    if not rel:
        return {"path": None, "text": "", "hash": _hash(""), "references": []}
    mine = _section(_read(_vault() / rel))[0]
    return {"path": rel, "text": mine, "hash": _hash(mine), "references": references(mine, (key,))}


class Conflict(Exception):
    def __init__(self, current: dict):
        super().__init__("the note changed in Obsidian since you started editing")
        self.current = current


def save(key: str, text: str, base_hash: str | None, force: bool = False) -> dict:
    """Replace "My notes" with text (making the note first if needed) and refresh the References. Refused with
    Conflict when the section is no longer the version base_hash names, unless force."""
    with WRITE_LOCK:
        return _save_locked(key, text, base_hash, force)


def _save_locked(key: str, text: str, base_hash: str | None, force: bool = False) -> dict:
    rel = find(key, thorough=True) or create(key)["path"]
    path = _vault() / rel
    current = _read(path)
    mine, where = _section(current)
    if not force and base_hash and _hash(mine) != base_hash and _hash(mine) != _hash(text):
        raise Conflict({"path": rel, "text": mine, "hash": _hash(mine), "references": references(mine, (key,))})
    content = (text.strip("\n") or PLACEHOLDER) + "\n\n"
    if where:
        new = current[:where[0]] + "\n" + content + current[where[1]:].lstrip("\n")
    else:  # the heading was removed: put the section back just before the Zotero block
        span = block_span(current)
        at = span[0] if span else len(current)
        new = current[:at].rstrip("\n") + "\n\n## My notes\n\n" + content + current[at:]
    if new != current:
        path.write_text(new, encoding="utf-8")
    refresh(key, rel)
    return {"path": rel, "hash": _hash(text.strip("\n")), "references": references(text, (key,))}


def render(markdown_text: str) -> str:
    """HTML for the editor's preview. Citations become spans the plugin turns into links; wiki links become
    plain spans. The plugin still sanitises the result before showing it."""
    import markdown
    known = lookup(cited(markdown_text))

    def citation(m: re.Match) -> str:
        chips = []
        for k in CITEKEY.findall(m.group(1)):
            k = k.rstrip(".,;:")
            entry = known.get(k)
            if entry:
                authors = entry["meta"].get("authors", [])
                label = (authors[0].split(" ")[-1] + (" et al." if len(authors) > 2 else "") if authors else k)
                label += f" {entry['meta'].get('year', '')}".rstrip()
                chips.append(f'<span class="cite" data-key="{entry["key"]}" title="{html.escape(entry["title"])}">'
                             f"{html.escape(label)}</span>")
            else:
                chips.append(f'<span class="cite missing">@{html.escape(k)}</span>')
        return "(" + "; ".join(chips) + ")"

    text = CITATION.sub(citation, markdown_text)
    text = re.sub(r"\[\[([^\]|]+)(?:\|([^\]]+))?\]\]",
                  lambda m: f'<span class="wikilink">{html.escape(m.group(2) or m.group(1))}</span>', text)
    return markdown.markdown(text, extensions=["extra", "sane_lists"])


def refresh_changed(keys: list[str]) -> int:
    """After Zotero indexing: bring the notes of changed papers up to date."""
    folder = _vault() / FOLDER
    if not keys or not folder.is_dir():
        return 0
    wanted = set(keys)
    zotero.snapshot("reader").close()  # a fresh copy, so the notes get the changes just indexed
    count = 0
    for path in folder.rglob("*.md"):
        head = path.read_text(encoding="utf-8", errors="replace")[:2000]
        m = re.search(r"^zotero-key:\s*\"?([A-Z0-9]{8})\"?\s*$", head, re.M)
        if m and m.group(1) in wanted:
            try:
                count += refresh(m.group(1), str(path.relative_to(_vault())))
            except Exception:  # noqa: BLE001 - one bad note must not stop indexing
                continue
    return count
