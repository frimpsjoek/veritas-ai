"""GET /web/page?url=&prefer=reader and GET /web/pdf?url= (spec 022): the server half of the web app's link panel.

/web/page answers one of {mode: frame | reader | pdf | blocked}. A paper link (a DOI) first looks for a copy the user
can read: the PDF in the Zotero library, then an open-access PDF from OpenAlex, then the abstract; only then the
publisher's page, which most publishers refuse to non-browsers (bot protection) and to frames (x-frame-options).
/web/pdf streams the PDF the reader shows; a DOI link there means the library's copy or the open-access one.

Only public http(s) sites are asked, also after a redirect (site_icons.public_host). Nothing a site sends is served as
a page: the reader view is rebuilt from an allow-list of tags. OpenAlex answers are kept a day, PDFs an hour.
"""
from __future__ import annotations

import hashlib
import html
import html.parser
import json
import re
import socket
import sqlite3
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

import kb
import pdf_route
import site_icons
import zotero

FOLDER = "web-pages"
TIMEOUT = 15
PAGE_MAX_BYTES = 3_000_000
PDF_MAX_BYTES = 80_000_000
OPENALEX_DAYS = 1
PDF_HOURS = 1
MIN_TEXT = 200
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 SecondBrain/1.0"
DOI = re.compile(r"(10\.\d{4,9}/[^\s?#]+)")
DOI_HOSTS = ("doi.org", "dx.doi.org")

BOT = "The publisher only answers web browsers (bot protection). Open it in your browser."
SLOW = "The site took too long to answer."
NO_TEXT = "This page has no text that can be shown here (it may need JavaScript or a sign-in)."
NOT_PUBLIC = "This link does not open here (not a public website)."


class Refused(ValueError):
    """A link this server will not ask for."""


@dataclass
class Response:
    url: str
    status: int
    headers: dict = field(default_factory=dict)  # lower-case names
    body: bytes = b""

    @property
    def kind(self) -> str:
        return self.headers.get("content-type", "").split(";")[0].strip().lower()


def folder(name: str = "") -> Path:
    path = kb.HOME / "data" / FOLDER / name
    path.mkdir(parents=True, exist_ok=True)
    return path


def _check(url: str) -> urllib.parse.ParseResult:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise Refused(NOT_PUBLIC)
    try:
        site_icons.public_host((parsed.hostname or "").lower())
    except site_icons.Refused as error:
        raise Refused(NOT_PUBLIC) from error
    return parsed


class _Checked(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _check(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_opener = urllib.request.build_opener(_Checked)


def fetch(url: str, limit: int = PAGE_MAX_BYTES, accept: str = "text/html,application/pdf;q=0.9,*/*;q=0.8") -> Response:
    """One GET, redirects followed (each checked). An HTTP error is an answer, not an exception; a body over `limit`
    is cut at limit+1 bytes so the caller can tell."""
    _check(url)
    request = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": accept, "Accept-Language": "en"})
    try:
        with _opener.open(request, timeout=TIMEOUT) as r:
            return Response(r.geturl(), r.status, {k.lower(): v for k, v in r.headers.items()}, r.read(limit + 1))
    except urllib.error.HTTPError as error:
        return Response(error.geturl() or url, error.code, {k.lower(): v for k, v in (error.headers or {}).items()},
                        error.read(65_536) if error.fp else b"")


# --- paper links ---------------------------------------------------------------------------------------------------

def doi_of(url: str) -> str | None:
    """The DOI a link names: doi.org/10.x/y, dx.doi.org, or a publisher path holding one (pubs.acs.org/doi/10.x/y)."""
    try:
        parsed = urllib.parse.urlparse(url)
    except ValueError:
        return None
    host = (parsed.hostname or "").lower().removeprefix("www.")
    path = urllib.parse.unquote(parsed.path)
    if host in DOI_HOSTS:
        found = DOI.match(path.lstrip("/"))
    else:
        found = re.search(r"/doi/(?:abs/|full/|pdf/|epdf/|reader/)?(10\.\d{4,9}/[^\s?#]+)", path)
    if not found:
        return None
    return found.group(1).rstrip("/.").lower()


def library_pdf(doi: str) -> tuple[str, str] | None:
    """(attachment key, title) of a PDF in the Zotero library for this DOI, or None."""
    if not zotero.root().is_dir():
        return None
    try:
        rows = zotero.snapshot("reader", max_age=60).execute(
            """SELECT a_items.key, (SELECT v2.value FROM itemData d2 JOIN itemDataValues v2 USING(valueID)
                                    JOIN fields f2 USING(fieldID) WHERE d2.itemID=d.itemID AND f2.fieldName='title')
               FROM itemData d JOIN itemDataValues v USING(valueID) JOIN fields f USING(fieldID)
               JOIN itemAttachments a ON a.parentItemID = d.itemID JOIN items a_items ON a_items.itemID = a.itemID
               WHERE f.fieldName='DOI' AND lower(v.value)=? AND a.contentType='application/pdf'
                 AND a.itemID NOT IN (SELECT itemID FROM deletedItems)""", (doi.lower(),)).fetchall()
    except (sqlite3.Error, OSError):
        return None
    for key, title in rows:
        try:
            pdf_route.resolve(key)
        except pdf_route.Refused:
            continue
        return key, title or doi
    return None


def _fresh(path: Path, seconds: float) -> bool:
    try:
        return time.time() - path.stat().st_mtime < seconds
    except OSError:
        return False


def openalex(doi: str, get=fetch) -> dict | None:
    """The OpenAlex work for a DOI (title, authors, abstract, open-access PDFs), kept a day; None when unknown."""
    path = folder("openalex") / f"{hashlib.sha1(doi.encode()).hexdigest()}.json"
    if _fresh(path, OPENALEX_DAYS * 86400):
        try:
            return json.loads(path.read_text()) or None
        except (OSError, ValueError):
            pass
    select = "title,display_name,authorships,abstract_inverted_index,best_oa_location,locations,primary_location"
    try:
        answer = get(f"https://api.openalex.org/works/doi:{urllib.parse.quote(doi, safe='/')}?select={select}",
                     2_000_000, "application/json")
    except (OSError, Refused):
        return None  # OpenAlex away: no fallback now, not an error, and not remembered
    work = None
    if answer.status == 200:
        try:
            work = json.loads(answer.body)
        except ValueError:
            work = None
    elif answer.status != 404:
        return None
    path.write_text(json.dumps(work or {}))
    return work


def abstract_of(work: dict) -> str:
    index = work.get("abstract_inverted_index") or {}
    words = sorted((at, word) for word, places in index.items() for at in places)
    return " ".join(word for _, word in words)


def byline_of(work: dict) -> str:
    names = [(a.get("author") or {}).get("display_name") for a in work.get("authorships") or []]
    names = [n for n in names if n]
    return ", ".join(names[:6]) + (f" and {len(names) - 6} more" if len(names) > 6 else "")


VERSIONS = {"submittedVersion": "submitted", "acceptedVersion": "accepted", "publishedVersion": "published"}


def oa_pdf(work: dict) -> dict | None:
    """The best open-access PDF: OpenAlex's best location first, then any other with a pdf_url."""
    places = [work.get("best_oa_location")] + list(work.get("locations") or [])
    for place in places:
        if place and place.get("is_oa") and place.get("pdf_url"):
            source = (place.get("source") or {}).get("display_name") or urllib.parse.urlparse(place["pdf_url"]).hostname
            return {"url": place["pdf_url"], "version": VERSIONS.get(place.get("version") or "", "published"),
                    "where": source}
    return None


def _paper(url: str, doi: str, get) -> dict | None:
    """A paper link's answer from the library, OpenAlex's open-access copy or its abstract; None to try the page."""
    found = library_pdf(doi)
    if found:
        # the panel asks /web/pdf for answer.url; for a DOI link that is the library's file again (pdf_file)
        return {"mode": "pdf", "url": f"https://doi.org/{doi}", "title": found[1], "source": "library"}
    work = openalex(doi, get)
    if not work:
        return None
    title = work.get("title") or work.get("display_name") or doi
    pdf = oa_pdf(work)
    if pdf:
        return {"mode": "pdf", "url": pdf["url"], "title": title, "source": "open access", "version": pdf["version"],
                "where": pdf["where"]}
    text = abstract_of(work)
    if not text:
        return None
    landing = ((work.get("primary_location") or {}).get("landing_page_url")) or f"https://doi.org/{doi}"
    body = (f"<p>{html.escape(text)}</p><p><em>Only the abstract is open. "
            f'<a href="{html.escape(landing, quote=True)}">Open the publisher\'s page</a>.</em></p>')
    return {"mode": "reader", "url": url, "title": title, "byline": byline_of(work), "html": body, "source": "openalex"}


# --- ordinary pages ------------------------------------------------------------------------------------------------

def frame_allowed(headers: dict) -> bool:
    """Whether a browser will show this page in our iframe: no x-frame-options and no CSP frame-ancestors (other
    than *). The app runs on localhost or a tailnet name, which no site lists."""
    if headers.get("x-frame-options", "").strip():
        return False
    for policy in headers.get("content-security-policy", "").split(","):
        for directive in policy.split(";"):
            parts = directive.split()
            if parts and parts[0].lower() == "frame-ancestors" and parts[1:] != ["*"]:
                return False
    return True


def _blocked_reason(answer: Response) -> str:
    server = answer.headers.get("server", "").lower()
    if answer.headers.get("cf-mitigated") or (answer.status in (403, 429, 503) and ("cloudflare" in server or b"captcha" in answer.body.lower())):
        return BOT
    if answer.status in (401, 403):
        return "The site needs a sign-in. Open it in your browser."
    if answer.status == 404:
        return "The site says this page does not exist (404)."
    if answer.status == 429:
        return "The site is asking us to slow down. Try again in a minute."
    return f"The site answered with an error ({answer.status})."


KEEP = {"p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "pre", "code", "em", "strong", "b",
        "i", "sub", "sup", "a", "br", "figcaption", "table", "thead", "tbody", "tr", "th", "td", "dl", "dt", "dd"}
SKIP = {"script", "style", "noscript", "svg", "nav", "header", "footer", "aside", "form", "button", "iframe", "template",
        "select", "textarea", "head", "object", "canvas", "dialog", "menu"}
VOID = {"br", "img", "hr", "meta", "link", "input", "source", "wbr", "area", "base", "col", "embed", "param", "track"}


class _Reader(html.parser.HTMLParser):
    """Rebuilds the page's text from KEEP tags only (no attributes but an absolute http(s) href), skipping SKIP
    subtrees, and keeps one copy per <article>/<main> so the main text can be chosen over the whole body. A skipped
    subtree ends at its own closing tag, so unclosed tags inside it (real pages have many) cannot swallow the page."""

    def __init__(self, base: str) -> None:
        super().__init__(convert_charrefs=True)
        self.base = base
        self.skip_tag = ""
        self.skip_n = 0
        self.out: list[str] = []  # the whole page
        self.zones: list[list[str]] = []  # <article>/<main> copies being written
        self.done_zones: list[str] = []
        self.title = ""
        self.in_title = False
        self.meta: dict[str, list[str]] = {}

    def _emit(self, text: str) -> None:
        self.out.append(text)
        for zone in self.zones:
            zone.append(text)

    def handle_starttag(self, tag, attrs):
        a = {k.lower(): (v or "") for k, v in attrs}
        if tag == "meta":
            name = (a.get("name") or a.get("property") or "").lower()
            if name and a.get("content"):
                self.meta.setdefault(name, []).append(a["content"])
            return
        if tag == "title":
            self.in_title = True
            return
        if self.skip_n:
            self.skip_n += tag == self.skip_tag
            return
        if tag in SKIP:
            self.skip_tag, self.skip_n = tag, 1
            return
        if tag in ("article", "main"):
            self.zones.append([])
        elif tag == "a":
            href = urllib.parse.urljoin(self.base, a.get("href", ""))
            ok = urllib.parse.urlparse(href).scheme in ("http", "https")
            self._emit(f'<a href="{html.escape(href, quote=True)}">' if ok else "<a>")
        elif tag in KEEP:
            self._emit(f"<{tag}>")

    def handle_endtag(self, tag):
        if tag == "title":
            self.in_title = False
            return
        if self.skip_n:
            self.skip_n -= tag == self.skip_tag
            return
        if tag in ("article", "main") and self.zones:
            self.done_zones.append("".join(self.zones.pop()))
        elif tag in KEEP and tag not in VOID:
            self._emit(f"</{tag}>")

    def handle_data(self, data):
        if self.in_title:
            self.title += data
            return
        if not self.skip_n:
            self._emit(html.escape(data, quote=False))


def _text_length(fragment: str) -> int:
    return len(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", fragment)).strip())


def reader(url: str, page: bytes, kind_charset: str = "") -> dict | None:
    """{title, byline, html} of a page's main text, or None when it has too little text to show."""
    charset = re.search(r"charset=([\w-]+)", kind_charset or "")
    try:
        text = page.decode(charset.group(1) if charset else "utf-8", "replace")
    except LookupError:
        text = page.decode("utf-8", "replace")
    parser = _Reader(url)
    try:
        parser.feed(text)
        parser.close()
    except Exception:  # noqa: BLE001 - a broken page gives whatever was read
        pass
    candidates = parser.done_zones + ["".join(z) for z in parser.zones]
    best = max(candidates, key=_text_length, default="")
    whole = "".join(parser.out)
    body = best if _text_length(best) >= MIN_TEXT else whole
    # drop the empty tags a stripped page leaves behind
    for _ in range(3):
        body = re.sub(r"<(\w+)>\s*</\1>", "", body)
    if _text_length(body) < MIN_TEXT:
        return None
    meta = parser.meta
    title = (meta.get("citation_title") or meta.get("og:title") or [parser.title.strip()])[0] or url
    authors = meta.get("citation_author") or meta.get("author") or []
    return {"title": html.unescape(title).strip(), "byline": ", ".join(authors[:6]), "html": body.strip()}


def _is_pdf(answer: Response) -> bool:
    return answer.kind == "application/pdf" or answer.body[:5] == b"%PDF-"


def page(url: str, prefer: str | None = None, get=fetch) -> dict:
    """The answer to GET /web/page (see the module docstring)."""
    try:
        _check(url)
    except Refused as error:
        return {"mode": "blocked", "url": url, "title": url, "reason": str(error)}
    host = urllib.parse.urlparse(url).hostname or url
    doi = doi_of(url)
    if doi:
        found = _paper(url, doi, get)
        if found:
            return found
    try:
        answer = get(url)
    except Refused as error:
        return {"mode": "blocked", "url": url, "title": host, "reason": str(error)}
    except (socket.timeout, TimeoutError):
        return {"mode": "blocked", "url": url, "title": host, "reason": SLOW}
    except urllib.error.URLError as error:
        if isinstance(error.reason, (socket.timeout, TimeoutError)):
            return {"mode": "blocked", "url": url, "title": host, "reason": SLOW}
        return {"mode": "blocked", "url": url, "title": host, "reason": "Second Brain couldn't reach the site."}
    except OSError:
        return {"mode": "blocked", "url": url, "title": host, "reason": "Second Brain couldn't reach the site."}
    final = answer.url or url
    if answer.status >= 400:
        return {"mode": "blocked", "url": final, "title": host, "reason": _blocked_reason(answer)}
    if _is_pdf(answer):
        return {"mode": "pdf", "url": final, "title": urllib.parse.unquote(final.rstrip("/").rsplit("/", 1)[-1]) or "PDF"}
    read = reader(final, answer.body[:PAGE_MAX_BYTES], answer.headers.get("content-type", ""))
    title = (read or {}).get("title") or host
    if prefer != "reader" and urllib.parse.urlparse(final).scheme == "https" and frame_allowed(answer.headers):
        return {"mode": "frame", "url": final, "title": title}
    if read:
        return {"mode": "reader", "url": final, **read}
    return {"mode": "blocked", "url": final, "title": title, "reason": NO_TEXT}


# --- /web/pdf ------------------------------------------------------------------------------------------------------

def _prune(where: Path) -> None:
    for old in where.glob("*.pdf"):
        if not _fresh(old, PDF_HOURS * 3600):
            old.unlink(missing_ok=True)


def pdf_file(url: str, get=fetch) -> Path:
    """A local PDF file for GET /web/pdf: the library's copy for a DOI link, else the URL fetched (kept an hour so
    PDF.js range requests do not fetch it again). Raises Refused (not public), ValueError (not a PDF, too large)."""
    doi = doi_of(url)
    if doi:
        found = library_pdf(doi)
        if found:
            return pdf_route.resolve(found[0])
        work = openalex(doi, get)
        pdf = oa_pdf(work) if work else None
        if pdf:
            url = pdf["url"]
    where = folder("pdf")
    _prune(where)
    path = where / f"{hashlib.sha1(url.encode()).hexdigest()}.pdf"
    if _fresh(path, PDF_HOURS * 3600):
        return path
    answer = get(url, PDF_MAX_BYTES, "application/pdf,*/*;q=0.5")
    if answer.status >= 400:
        raise ValueError(_blocked_reason(answer))
    if answer.body[:5] != b"%PDF-":
        raise ValueError("This link is not a PDF")
    if len(answer.body) > PDF_MAX_BYTES:
        raise ValueError("This PDF is too large to open here")
    tmp = path.with_suffix(".tmp")
    tmp.write_bytes(answer.body)
    tmp.replace(path)
    return path
