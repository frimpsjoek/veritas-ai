"""A paper's graphical abstract (or first figure) for the web app's Home, found without a key and cached.

Tried in order, each only when it applies:
1. arXiv: the first figure of the paper's HTML page (arxiv.org/html/<id>).
2. Springer, Nature and BMC: the first figure, whose address follows from the DOI
   (10.1038/s41524-026-02351-z -> .../41524_2026_2351_Fig1_HTML.png), checked to exist.
3. The paper's arXiv preprint, found through OpenAlex: its first figure (ACS, APS, RSC and Elsevier refuse requests
   that do not come from a browser, so a preprint is the only way to a figure for most of their papers).
4. The article page's own preview image (og:image / twitter:image), unless it is a logo or a journal cover.

Answers are kept in data/web/paper-figures.json. A "none" every source answered is asked again after a week; a none
caused by an error (a timeout, no network) after an hour; a none an older finder gave (FINDER) at once. The browser loads the image from its source.
"""
from __future__ import annotations

import base64
import gzip
import io
import json
import posixpath
import re
import tarfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import kb

CACHE = kb.data_dir() / "web" / "paper-figures.json"
RETRY_NONE_S = 7 * 24 * 3600
RETRY_ERROR_S = 3600  # a none that came from an error (timeout, network), not from every source saying no
TIMEOUT_S = 8
FINDER = 3  # raised when the finder learns a new kind of figure: a none an older finder gave is asked again at once
FIGURE_DIR = CACHE.parent / "paper-figures"  # figures drawn from a paper's source files (spec 035 R3)
SOURCE_LIMIT = 40_000_000  # an arXiv source larger than this is not read (spec 035 R4)
SOURCE_SPACING_S = 3.0  # at most one arXiv source download every 3 seconds, across the server
SOURCE_UA = "Veritas paper-figure finder (+https://github.com/frimpsjoek/veritas-ai)"
FIGURE_WIDTH = 1000
GRAPHIC_EXTS = (".png", ".jpg", ".jpeg", ".pdf")
ARXIV_PAGE_LIMIT = 4_000_000  # a long paper's page runs to megabytes; its first figure can sit past the first 600 kB
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
GENERIC = re.compile(r"logo|cover|default|placeholder|favicon|social|share|banner|sprite|icon", re.I)
SPRINGER = re.compile(r"10\.(?:1038|1007|1186)/s(\d+)-(\d{3})-(\d+)-\w", re.I)
ARXIV_ID = re.compile(r"(\d{4}\.\d{4,5})(v\d+)?")

_lock = threading.Lock()
_cache: dict | None = None


def _load() -> dict:
    global _cache
    if _cache is None:
        try:
            _cache = json.loads(CACHE.read_text())
        except (OSError, ValueError):
            _cache = {}
    return _cache


def _save() -> None:
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    tmp = CACHE.with_suffix(".tmp")
    tmp.write_text(json.dumps(_cache))
    tmp.replace(CACHE)


def _get(url: str, limit: int = 600_000) -> tuple[int, str, bytes]:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html,image/*;q=0.9,*/*;q=0.8"})
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:
        return r.status, r.geturl(), r.read(limit)


def springer_figure(doi: str) -> str | None:
    """The first-figure address Springer Nature uses for this DOI, or None when the DOI is not theirs."""
    m = SPRINGER.fullmatch(doi.strip())
    if not m:
        return None
    journal, yy, number = m.groups()
    year = 2000 + int(yy[-2:])
    return (f"https://media.springernature.com/lw685/springer-static/image/art%3A{urllib.parse.quote(doi.strip(), safe='')}"
            f"/MediaObjects/{journal}_{year}_{int(number)}_Fig1_HTML.png")


def arxiv_id(arxiv: str | None, url: str | None) -> str | None:
    text = arxiv or (url if url and "arxiv" in url.lower() else "")
    m = ARXIV_ID.search(text or "")
    return m.group(1) if m else None


def preview_image(html: str, page: str) -> str | None:
    """og:image or twitter:image from an article page, made absolute; None for a logo or cover."""
    for pattern in (r'<meta[^>]+(?:property|name)=["\'](?:og:image|twitter:image)["\'][^>]*content=["\']([^"\']+)',
                    r'<meta[^>]+content=["\']([^"\']+)["\'][^>]*(?:property|name)=["\'](?:og:image|twitter:image)["\']'):
        m = re.search(pattern, html, re.I)
        if m:
            src = urllib.parse.urljoin(page, m.group(1).replace("&amp;", "&"))
            return None if GENERIC.search(urllib.parse.urlparse(src).path) else src
    return None


def arxiv_figure(aid: str) -> str | None:
    """The first figure of an arXiv paper's HTML page, or None when it has none (raises on a network error)."""
    status, page, body = _get(f"https://arxiv.org/html/{aid}", limit=ARXIV_PAGE_LIMIT)
    found = first_figure(body.decode("utf8", "ignore"))
    return urllib.parse.urljoin(page, found) if status == 200 and found else None


def first_figure(html: str) -> str | None:
    """The address of the first figure on an arXiv (LaTeXML) page: an <img src> or, for an SVG figure, an
    <object data>, whichever comes first, each marked class="ltx_graphics"."""
    for m in re.finditer(r"<(?:img|object)\b[^>]*>", html, re.I):
        tag = m.group(0)
        if not re.search(r'class="[^"]*\bltx_graphics\b', tag):
            continue
        src = re.search(r'\b(?:src|data)="([^"]+)"', tag)
        if src:
            return src.group(1)
    return None


def preprint_of(doi: str) -> str | None:
    """The arXiv id of a journal paper's preprint, from OpenAlex's locations; None when it has none."""
    _, _, body = _get(f"https://api.openalex.org/works/doi:{urllib.parse.quote(doi.strip(), safe='/')}?select=locations,ids", limit=400_000)
    m = re.search(r"arxiv\.org/(?:abs|pdf)/(\d{4}\.\d{4,5})", body.decode("utf8", "ignore"))
    return m.group(1) if m else None


_source_lock = threading.Lock()
_last_source = [0.0]


def source_bytes(aid: str, clock=time.monotonic, sleep=time.sleep) -> bytes | None:
    """An arXiv paper's source download (raises on a network error); None when larger than SOURCE_LIMIT. Downloads
    wait for each other so that two are at least SOURCE_SPACING_S apart (arXiv asks automated clients to go slowly)."""
    with _source_lock:
        wait = _last_source[0] + SOURCE_SPACING_S - clock()
        if wait > 0:
            sleep(wait)
        try:
            req = urllib.request.Request(f"https://arxiv.org/e-print/{aid}", headers={"User-Agent": SOURCE_UA})
            with urllib.request.urlopen(req, timeout=30) as r:
                body = r.read(SOURCE_LIMIT + 1)
        finally:
            _last_source[0] = clock()
    return None if len(body) > SOURCE_LIMIT else body


def source_files(body: bytes) -> dict[str, bytes] | bytes:
    """The files of an arXiv source, by path: a gzipped tar, a plain tar or one gzipped .tex. A PDF source (the
    authors gave no LaTeX) comes back as its bytes. Nothing is written to disk."""
    if body[:5] == b"%PDF-":
        return body
    data = body
    if body[:2] == b"\x1f\x8b":
        with gzip.GzipFile(fileobj=io.BytesIO(body)) as z:
            data = z.read(SOURCE_LIMIT * 5)
        if data[:5] == b"%PDF-":
            return data
    try:
        with tarfile.open(fileobj=io.BytesIO(data)) as tar:
            files = {}
            for m in tar.getmembers():
                if m.isfile() and m.size <= SOURCE_LIMIT:
                    f = tar.extractfile(m)
                    if f:
                        files[posixpath.normpath(m.name.lstrip("./"))] = f.read()
            return files
    except tarfile.TarError:
        return {"main.tex": data}  # one .tex file, gzipped


_COMMAND = re.compile(r"\\(input|include|includegraphics|graphicspath)\*?\s*(?:\[[^\]]*\]\s*)*\{((?:[^{}]|\{[^{}]*\})*)\}")


def _uncomment(tex: str) -> str:
    return re.sub(r"(?<!\\)%.*", "", tex)


def included_graphics(files: dict[str, bytes]) -> list[str]:
    """The paths of the figures the paper includes, in the order it includes them: from the main .tex file (the one
    with \\documentclass, main.tex first), following \\input and \\include in place, resolved against \\graphicspath
    and the usual extensions. Only files that are in the source."""
    texs = sorted((n for n in files if n.lower().endswith(".tex") and b"\\documentclass" in files[n]),
                  key=lambda n: (posixpath.basename(n).lower() != "main.tex", n.count("/"), n))
    if not texs:
        return []
    found: list[str] = []
    paths = [""]
    seen: set[str] = set()

    def resolve(base: str, name: str, exts: tuple[str, ...]) -> str | None:
        name = name.strip().strip('"')
        for folder in [base, *paths]:
            stem = posixpath.normpath(posixpath.join(folder, name))
            for candidate in ([stem] if stem.lower().endswith(exts) else []) + [stem + e for e in exts]:
                if candidate in files:
                    return candidate
        return None

    def walk(path: str, depth: int) -> None:
        if path in seen or depth > 6:
            return
        seen.add(path)
        tex = _uncomment(files[path].decode("utf8", "ignore"))
        base = posixpath.dirname(path)
        for command, arg in _COMMAND.findall(tex):
            if command == "graphicspath":
                paths[:] = [p.strip() for p in re.findall(r"\{([^{}]*)\}", arg)] + [""]
            elif command == "includegraphics":
                hit = resolve(base, arg, GRAPHIC_EXTS + (".eps",))
                if hit and hit not in found:
                    found.append(hit)
            else:
                hit = resolve(base, arg, (".tex",)) or resolve("", arg, (".tex",))
                if hit:
                    walk(hit, depth + 1)

    walk(texs[0], 0)
    return found


def _jpeg(image) -> bytes:
    """A picture as a JPEG at most FIGURE_WIDTH wide, transparency on white."""
    from PIL import Image
    if image.mode in ("RGBA", "LA", "P"):
        image = image.convert("RGBA")
        white = Image.new("RGB", image.size, "white")
        white.paste(image, mask=image.split()[-1])
        image = white
    image = image.convert("RGB")
    if image.width > FIGURE_WIDTH:
        image = image.resize((FIGURE_WIDTH, round(image.height * FIGURE_WIDTH / image.width)))
    out = io.BytesIO()
    image.save(out, "JPEG", quality=85)
    return out.getvalue()


def draw_figure(name: str, data: bytes) -> bytes | None:
    """One figure file as a JPEG: a PNG or JPEG read as it is, a PDF's first page drawn; None for EPS or a file
    that cannot be read."""
    try:
        if name.lower().endswith(".pdf"):
            import pypdfium2 as pdfium
            page = pdfium.PdfDocument(data)[0]
            scale = min(4.0, max(1.0, FIGURE_WIDTH / max(page.get_width(), 1)))
            return _jpeg(page.render(scale=scale).to_pil())
        if name.lower().endswith((".png", ".jpg", ".jpeg")):
            from PIL import Image
            return _jpeg(Image.open(io.BytesIO(data)))
    except Exception:  # noqa: BLE001 - a broken figure file is skipped for the next one
        return None
    return None


def pdf_picture(data: bytes, pages: int = 60, min_px: tuple[int, int] = (300, 200)) -> bytes | None:
    """The first picture of a PDF source at least min_px pixels, cut from its drawn page (spec 035 R2)."""
    import pypdfium2 as pdfium
    import pypdfium2.raw as raw
    doc = pdfium.PdfDocument(data)
    for i in range(min(pages, len(doc))):
        page = doc[i]
        for obj in page.get_objects(filter=[raw.FPDF_PAGEOBJ_IMAGE], max_depth=2):
            w, h = obj.get_px_size()
            if w < min_px[0] or h < min_px[1]:
                continue
            left, bottom, right, top = obj.get_bounds()
            scale = min(4.0, max(1.0, FIGURE_WIDTH / max(right - left, 1)))
            drawn = page.render(scale=scale).to_pil()
            height = page.get_height()
            box = (max(0, round(left * scale)), max(0, round((height - top) * scale)),
                   min(drawn.width, round(right * scale)), min(drawn.height, round((height - bottom) * scale)))
            if box[2] - box[0] > 10 and box[3] - box[1] > 10:
                return _jpeg(drawn.crop(box))
    return None


def source_figure(aid: str, fetch=source_bytes) -> str | None:
    """Spec 035: the first figure of an arXiv paper drawn from its source files, kept as FIGURE_DIR/<id>.jpg;
    answers "file:<id>.jpg", or None when the source has no figure Veritas can draw (raises on a network error)."""
    body = fetch(aid)
    if not body:
        return None
    files = source_files(body)
    jpeg = None
    if isinstance(files, bytes):
        jpeg = pdf_picture(files)
    else:
        for name in included_graphics(files):
            jpeg = draw_figure(name, files[name])
            if jpeg:
                break
    if not jpeg:
        return None
    name = re.sub(r"[^0-9A-Za-z.]+", "_", aid) + ".jpg"
    FIGURE_DIR.mkdir(parents=True, exist_ok=True)
    (FIGURE_DIR / name).write_bytes(jpeg)
    return f"file:{name}"


def _shown(image: str | None) -> str | None:
    """What the browser is given: a kept figure as a data: address (spec 035 R3), anything else as it is; None when a
    kept file has gone."""
    if not image or not image.startswith("file:"):
        return image
    try:
        return "data:image/jpeg;base64," + base64.b64encode((FIGURE_DIR / image[5:]).read_bytes()).decode()
    except OSError:
        return None


def _find(doi: str, arxiv: str | None, url: str | None) -> tuple[str | None, bool]:
    """(image, settled): settled is False when a source could not be asked (an error), so a none is retried soon."""
    settled = True

    def attempt(fn, *args):
        nonlocal settled
        try:
            return fn(*args)
        except urllib.error.HTTPError:  # the site answered (403 bot check, 404): a real no
            return None
        except Exception:  # noqa: BLE001 - a timeout or no network: skipped, and the none is retried soon
            settled = False
            return None

    aid = arxiv_id(arxiv, url)
    if aid:
        found = attempt(arxiv_figure, aid) or attempt(source_figure, aid)
        if found:
            return found, True
    if doi:
        guess = springer_figure(doi)
        if guess and attempt(lambda: _get(guess, limit=64)[0] == 200):
            return guess, True
        if not aid:
            preprint = attempt(preprint_of, doi)
            found = (attempt(arxiv_figure, preprint) or attempt(source_figure, preprint)) if preprint else None
            if found:
                return found, True
        page = attempt(lambda: _get(f"https://doi.org/{urllib.parse.quote(doi.strip(), safe='/')}"))
        if page and page[0] == 200:
            found = preview_image(page[2].decode("utf8", "ignore"), page[1])
            if found:
                return found, True
    return None, settled


def figure(doi: str = "", arxiv: str | None = None, url: str | None = None, now: float | None = None) -> str | None:
    key = (doi or arxiv_id(arxiv, url) or url or "").strip().lower()
    if not key:
        return None
    now = time.time() if now is None else now
    with _lock:
        hit = _load().get(key)
    retry = RETRY_NONE_S if (hit or {}).get("settled", True) else RETRY_ERROR_S
    if hit and (hit.get("image") or (hit.get("finder", 1) >= FINDER and now - hit.get("at", 0) < retry)):
        shown = _shown(hit.get("image"))
        if shown or not hit.get("image"):
            return shown
    image, settled = _find(doi, arxiv, url)
    with _lock:
        _load()[key] = {"image": image, "at": now, "finder": FINDER, **({} if settled else {"settled": False})}
        _save()
    return _shown(image)
