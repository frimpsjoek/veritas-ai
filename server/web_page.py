"""GET /web/page?url=&prefer=reader and GET /web/pdf?url= (spec 022): the server half of the web app's link panel.

/web/page answers one of {mode: frame | reader | pdf | blocked}. A paper link (a DOI) first looks for a copy the user
can read: the PDF in the Zotero library, then an open-access PDF from OpenAlex, then the paper's page built from
OpenAlex and Crossref (journal, date, authors, the abstract's paragraphs, the DOI, a citation); only then the
publisher's page, which most publishers refuse to non-browsers (bot protection) and to frames (x-frame-options).
/web/pdf streams the PDF the reader shows; a DOI link there means the library's copy or the open-access one.

Only public http(s) sites are asked, also after a redirect (site_icons.public_host). Nothing a site sends is served as
a page: the reader view is rebuilt from an allow-list of tags. OpenAlex and Crossref answers are kept a day, PDFs an
hour.
"""
from __future__ import annotations

import hashlib
import html
import html.parser
import itertools
import json
import re
import socket
import sqlite3
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

import kb
import pdf_route
import radar_api
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
    path = kb.data_dir() / FOLDER / name
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
    select = ("title,display_name,authorships,abstract_inverted_index,best_oa_location,locations,primary_location,"
              "publication_date,publication_year,biblio,open_access")
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


def crossref(doi: str, get=fetch) -> dict | None:
    """The Crossref record for a DOI (its JATS abstract, journal, volume and pages), kept a day; None when unknown or
    away. Asked only for a paper with no open copy, whose page is then built from the record."""
    path = folder("crossref") / f"{hashlib.sha1(doi.encode()).hexdigest()}.json"
    if _fresh(path, OPENALEX_DAYS * 86400):
        try:
            return json.loads(path.read_text()) or None
        except (OSError, ValueError):
            pass
    try:
        answer = get(f"https://api.crossref.org/works/{urllib.parse.quote(doi, safe='/')}", 2_000_000, "application/json")
    except (OSError, Refused):
        return None
    record = None
    if answer.status == 200:
        try:
            record = json.loads(answer.body).get("message")
        except (ValueError, AttributeError):
            record = None
    elif answer.status != 404:
        return None
    path.write_text(json.dumps(record or {}))
    return record if isinstance(record, dict) else None


# The word "Abstract" that opens many abstracts (JATS <title>, or glued to OpenAlex's text), and the heading names
# that only repeat the panel's own label.
ABSTRACT_WORD = re.compile(r"^\s*(?:Graphical\s+)?(?:Abstract|ABSTRACT)\s*[:.\u2014-]?\s+(?=[A-Z0-9(<\"\u201c])")
ABSTRACT_TITLES = {"abstract", "graphical abstract", "summary", "toc", "table of contents graphic"}
JATS_INLINE = {"sub": "sub", "sup": "sup", "italic": "i", "i": "i", "em": "i", "bold": "b", "b": "b", "strong": "b"}
JATS_BLOCK = {"p", "sec", "list", "list-item", "title", "abstract", "trans-abstract", "fig", "caption", "disp-formula"}


class _Jats(html.parser.HTMLParser):
    """A Crossref abstract (JATS, tags prefixed "jats:" or not) as paragraphs: <p> for each paragraph and for loose
    text, <h3> for a section title other than "Abstract", <ul><li> for lists; sub, sup, italic and bold kept, every other
    tag dropped with its text kept, attributes never."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.blocks: list[str] = []  # finished blocks, html
        self.run: list[str] = []  # the open paragraph
        self.title: list[str] | None = None
        self.items: list[str] | None = None  # list items being collected

    def _end(self) -> None:
        text = "".join(self.run).strip()
        self.run = []
        if re.sub(r"<[^>]+>", "", text).strip():
            text = re.sub(r"\s+", " ", text)
            if self.items is not None:
                self.items.append(f"<li>{text}</li>")
            else:
                self.blocks.append(f"<p>{text}</p>")

    def handle_starttag(self, tag, attrs):
        name = tag.split(":")[-1]
        if name in JATS_INLINE:
            (self.title if self.title is not None else self.run).append(f"<{JATS_INLINE[name]}>")
        elif name == "title":
            self._end()
            self.title = []
        elif name == "list":
            self._end()
            self.items = []
        elif name in JATS_BLOCK:
            self._end()

    def handle_endtag(self, tag):
        name = tag.split(":")[-1]
        if name in JATS_INLINE:
            (self.title if self.title is not None else self.run).append(f"</{JATS_INLINE[name]}>")
        elif name == "title" and self.title is not None:
            text = re.sub(r"\s+", " ", "".join(self.title)).strip()
            self.title = None
            plain = re.sub(r"<[^>]+>", "", text).strip().rstrip(":.").strip()
            if plain and plain.lower() not in ABSTRACT_TITLES:
                self.blocks.append(f"<h3>{text}</h3>")
        elif name == "list":
            self._end()
            if self.items:
                self.blocks.append(f"<ul>{''.join(self.items)}</ul>")
            self.items = None
        elif name in JATS_BLOCK:
            self._end()

    def handle_data(self, data):
        (self.title if self.title is not None else self.run).append(html.escape(data, quote=False))


def jats_html(text: str) -> str:
    """A Crossref (JATS) or plain abstract as clean paragraphs, without the "Abstract" heading or leading word."""
    parser = _Jats()
    parser.feed(text or "")
    parser.close()
    parser._end()
    blocks = parser.blocks
    if blocks and blocks[0].startswith("<p>"):
        blocks[0] = "<p>" + ABSTRACT_WORD.sub("", blocks[0][3:], count=1)
    return "".join(blocks)


def abstract_text(fragment: str) -> str:
    """The plain text of an abstract's html, its paragraphs as one run (for clients that draw text only)."""
    return _words(html.unescape(re.sub(r"<[^>]+>", " ", re.sub(r"</?(?:sub|sup|i|b)>", "", fragment))))


def journal_of(work: dict, record: dict | None) -> str:
    """The journal's name, on one line (Crossref breaks "Journal of Chemical Theory and Computation" over two lines)."""
    name = ((work.get("primary_location") or {}).get("source") or {}).get("display_name") or ""
    if not name and record:
        titles = record.get("container-title") or []
        name = titles[0] if titles else ""
    return _words(name)


def published_of(work: dict, record: dict | None) -> str:
    """"28 Oct 2026" (or "Oct 2026", "2026"): OpenAlex's publication date, else Crossref's."""
    found = _day(work.get("publication_date") or "")
    if found:
        return found
    for key in ("published", "published-online", "published-print", "issued"):
        parts = (((record or {}).get(key) or {}).get("date-parts") or [[None]])[0]
        if parts and parts[0]:
            year, month, day = (list(parts) + [None, None])[:3]
            return " ".join(str(x) for x in (day, MONTHS[month - 1] if month else None, year) if x)
    return str(work.get("publication_year") or "")


def citation_of(doi: str, title: str, names: list[str], journal: str, year: str, volume: str, issue: str,
                pages: str) -> str:
    """One line to paste: "A. Author, B. Author. Title. Journal 2026, 12 (3), 101-118. https://doi.org/…"."""
    who = ", ".join(names[:20]) + (", et al." if len(names) > 20 else "")
    where = " ".join(x for x in (journal, year) if x)
    numbers = ", ".join(x for x in (where, f"{volume} ({issue})" if volume and issue else volume, pages) if x)
    title = _words(re.sub(r"<[^>]+>", "", title))
    return ". ".join(x.rstrip(".") for x in (who, title, numbers) if x) + f". https://doi.org/{doi}"


def _landing(url: str, doi: str, work: dict, record: dict | None, text: str) -> dict:
    """The page of a paper without an open copy: journal and date, authors, the abstract as paragraphs, the DOI, the
    publisher's page (outside: publishers refuse in-app loads) and a citation; a free copy OpenAlex knows as a button."""
    title = work.get("title") or work.get("display_name") or ((record or {}).get("title") or [doi])[0]
    biblio = work.get("biblio") or {}
    volume = str(biblio.get("volume") or (record or {}).get("volume") or "")
    issue = str(biblio.get("issue") or (record or {}).get("issue") or "")
    first, last = biblio.get("first_page"), biblio.get("last_page")
    pages = (f"{first}-{last}" if first and last and first != last else str(first or "")) or str((record or {}).get("page") or "")
    journal = journal_of(work, record)
    published = published_of(work, record)
    year = str(work.get("publication_year") or (published.rsplit(" ", 1)[-1] if published else ""))
    names = [n for n in ((a.get("author") or {}).get("display_name") for a in work.get("authorships") or []) if n]
    paper = {"doi": doi, "journal": journal, "published": published, "volume": volume, "issue": issue, "pages": pages, "authors": names,
             "citation": citation_of(doi, title, names, journal, year, volume, issue, pages)}
    links = [{"label": "Publisher's page", "url": f"https://doi.org/{doi}", "kind": "outside"}]
    access = work.get("open_access") or {}
    free = access.get("oa_url") if access.get("is_oa") else None
    if free and doi_of(free) != doi:
        links.append({"label": "PDF" if free.lower().split("?")[0].endswith(".pdf") else "Free copy", "url": free,
                      "kind": "pdf" if free.lower().split("?")[0].endswith(".pdf") else "page"})
    return {"mode": "reader", "url": url, "title": title, "byline": byline_of(work), "abstract": abstract_text(text),
            "abstract_html": text, "html": "", "source": "openalex", "paper": {k: v for k, v in paper.items() if v},
            "links": links}


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
    record = crossref(doi, get)
    # Crossref keeps the abstract's paragraphs, sub- and superscripts; OpenAlex only its words
    text = jats_html((record or {}).get("abstract") or "") or jats_html(html.escape(abstract_of(work), quote=False))
    if not text:
        return None
    return _landing(url, doi, work, record, text)


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
BLOCK = {"p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "pre", "figcaption", "table", "thead",
         "tbody", "tr", "th", "td", "dl", "dt", "dd"}
# Elements that are not kept but end a run of text: loose text between two of them becomes its own paragraph.
BOUNDARY = {"div", "section", "article", "main", "figure", "center", "address", "details", "summary", "hgroup",
            "fieldset", "body"}
SKIP = {"script", "style", "noscript", "svg", "nav", "header", "footer", "aside", "form", "button", "iframe", "template",
        "select", "textarea", "head", "object", "canvas", "dialog", "menu"}
# Text only screen readers get, and LaTeXML's author block, dates and footer (the header shows authors and dates).
SKIP_CLASSES = {"sr-only", "visually-hidden", "screen-reader-text", "ltx_authors", "ltx_dates", "ltx_page_footer"}
VOID = {"br", "img", "hr", "meta", "link", "input", "source", "wbr", "area", "base", "col", "embed", "param", "track"}
HEADING = re.compile(r"h[1-6]")
LABEL = re.compile(r"^\s*(Title|Authors?|Abstract)\s*:\s*")
BREADCRUMB = re.compile(r"\S\s+[>›»]\s+\S")
# Site furniture, matched only on short blocks (CHROME_MAX characters), so a sentence that merely uses the word stays.
CHROME = re.compile(r"(?:^|\s)toggle$|\(What (?:is|are) [^)]*\?\)|^Loading(?:\.\.\.|…)$|^Bookmark|^Cite as\b"
                    r"|^Submission history|^Change to browse by|Disable MathJax|^Full-text links|^Current browse context"
                    r"|^References (?:&|and) Citations|BibTeX|^Which authors of this paper|^Share (?:this|on)\b"
                    r"|^Skip to|\b(?:accept|allow|use|manage)\b.{0,40}\bcookies\b|^Cookie (?:settings|policy)", re.I)
CHROME_MAX = 120
REPEATED_MAX = 40  # a line this short printed twice or more is a button's label ("Read Later", "Share")
LINKY_MAX = 200
LINKY = 0.6
PANEL_TEXT = 200  # a section mostly of furniture goes only when this little text would go with it


class _Reader(html.parser.HTMLParser):
    """Rebuilds the page's text from KEEP tags only (no attributes but an absolute http(s) href), skipping SKIP
    subtrees and hidden ones, and keeps one copy per <article>/<main> so the main text can be chosen over the whole
    body. A skipped subtree ends at its own closing tag, so unclosed tags inside it (real pages have many) cannot
    swallow the page. Text outside any kept block (a <div> of text) is wrapped in <p>, so every piece of the page is a
    block the pruning can weigh. A <math> becomes $TeX$ from its alttext (or TeX annotation) for the client to draw."""

    def __init__(self, base: str) -> None:
        super().__init__(convert_charrefs=True)
        self.base = base
        self.skip_tag = ""
        self.skip_n = 0
        self.out: list[str] = []  # the whole page
        self.zones: list[tuple[str, list[str]]] = []  # <article>/<main> copies being written, by tag
        self.done_zones: list[tuple[str, str]] = []
        self.title = ""
        self.in_title = False
        self.meta: dict[str, list[str]] = {}
        self.blocks: list[str] = []  # kept block tags open now
        self.loose: list[str] = []  # inline text waiting for its paragraph
        self.math: dict | None = None
        self.has_math = False

    def _write(self, text: str) -> None:
        self.out.append(text)
        for _, zone in self.zones:
            zone.append(text)

    def _emit(self, text: str, inline: bool = True) -> None:
        if inline and not self.blocks:
            self.loose.append(text)
        else:
            self._write(text)

    def _flush(self) -> None:
        run, self.loose = "".join(self.loose), []
        if _text_length(run):
            self._write(f"<p>{run.strip()}</p>")

    def _open(self, tag: str) -> None:
        if not self.blocks:
            self._flush()
        if tag in ("p", "li") and self.blocks and self.blocks[-1] == tag:
            self._close(tag)  # <p>one<p>two: the browser closes the first
        self._write(f"<{tag}>")
        self.blocks.append(tag)

    def _close(self, tag: str) -> None:
        if tag not in self.blocks:
            return
        while self.blocks:
            top = self.blocks.pop()
            self._write(f"</{top}>")
            if top == tag:
                break

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
        if self.math is not None:
            if tag == "annotation" and a.get("encoding", "").lower() in ("application/x-tex", "tex"):
                self.math["in_tex"] = True
            return
        hidden = "hidden" in a or a.get("aria-hidden") == "true" or SKIP_CLASSES & set(a.get("class", "").split())
        if tag in SKIP or (hidden and tag not in VOID):
            self.skip_tag, self.skip_n = tag, 1
            return
        if tag == "math":
            self.math = {"tex": a.get("alttext", "").strip(), "buf": [], "in_tex": False}
            return
        if tag in BOUNDARY:
            if not self.blocks:
                self._flush()
            if tag in ("article", "main"):
                self.zones.append((tag, []))
        elif tag == "a":
            href = urllib.parse.urljoin(self.base, a.get("href", ""))
            ok = urllib.parse.urlparse(href).scheme in ("http", "https")
            self._emit(f'<a href="{html.escape(href, quote=True)}">' if ok else "<a>")
        elif tag in BLOCK:
            self._open(tag)
        elif tag in KEEP:
            self._emit(f"<{tag}>")

    def handle_endtag(self, tag):
        if tag == "title":
            self.in_title = False
            return
        if self.skip_n:
            self.skip_n -= tag == self.skip_tag
            return
        if self.math is not None:
            if tag == "annotation":
                self.math["in_tex"] = False
            elif tag == "math":
                tex = self.math["tex"] or "".join(self.math["buf"]).strip()
                self.math = None
                if tex:
                    self.has_math = True
                    self._emit(html.escape(f"${tex}$", quote=False))
            return
        if tag in BOUNDARY:
            if not self.blocks:
                self._flush()
            if tag in ("article", "main") and self.zones:
                zone_tag, zone = self.zones.pop()
                self.done_zones.append((zone_tag, "".join(zone)))
        elif tag in BLOCK:
            if not self.blocks:
                self._flush()
            self._close(tag)
        elif tag in KEEP and tag not in VOID:
            self._emit(f"</{tag}>")

    def handle_data(self, data):
        if self.in_title:
            self.title += data
            return
        if self.math is not None:
            if self.math["in_tex"]:
                self.math["buf"].append(data)
            return
        if not self.skip_n:
            self._emit(html.escape(data, quote=False))

    def close(self):
        super().close()
        self._flush()


def _text_length(fragment: str) -> int:
    return len(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", fragment)).strip())


# --- the reader's second pass: a small tree of the kept tags, weighed block by block ---------------------------------

@dataclass
class _Node:
    tag: str
    href: str = ""
    cls: str = ""
    kids: list = field(default_factory=list)  # _Node or str (unescaped text)

    def text(self) -> str:
        return "".join(k if isinstance(k, str) else k.text() for k in self.kids)

    def link_text(self) -> str:
        return "".join("" if isinstance(k, str) else (k.text() if k.tag == "a" else k.link_text()) for k in self.kids)

    def html(self) -> str:
        inner = "".join(html.escape(k, quote=False) if isinstance(k, str) else k.html() for k in self.kids)
        if self.tag == "#root":
            return inner
        attrs = (f' href="{html.escape(self.href, quote=True)}"' if self.href else "") + (f' class="{self.cls}"' if self.cls else "")
        return f"<{self.tag}{attrs}>" if self.tag in VOID else f"<{self.tag}{attrs}>{inner}</{self.tag}>"


class _Tree(html.parser.HTMLParser):
    """Parses the reader's own output back (known tags, an href at most); a stray closing tag is ignored."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.root = _Node("#root")
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        node = _Node(tag, dict(attrs).get("href") or "")
        self.stack[-1].kids.append(node)
        if tag not in VOID:
            self.stack.append(node)

    def handle_endtag(self, tag):
        for at in range(len(self.stack) - 1, 0, -1):
            if self.stack[at].tag == tag:
                del self.stack[at:]
                return

    def handle_data(self, data):
        self.stack[-1].kids.append(data)


def _tree(fragment: str) -> _Node:
    parser = _Tree()
    parser.feed(fragment)
    parser.close()
    return parser.root


def _words(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def _same(a: str, b: str) -> bool:
    norm = lambda s: re.sub(r"[\W_]+", " ", LABEL.sub("", s)).strip().lower()  # noqa: E731
    return bool(norm(a)) and norm(a) == norm(b)


def _is_chrome(node: _Node, repeated: frozenset = frozenset()) -> bool:
    """A leaf block that is site furniture: empty, mostly links, a short line the page repeats, or a known short
    phrase."""
    text = _words(node.text())
    if not text or text in repeated:
        return True
    if len(text) <= LINKY_MAX and len(_words(node.link_text())) >= LINKY * len(text):
        return True
    return len(text) <= CHROME_MAX and bool(CHROME.search(text))


CONTAINERS = {"ul", "ol", "dl", "table", "thead", "tbody", "blockquote"}


def _prune_items(node: _Node, repeated: frozenset) -> tuple[int, int]:
    """Drops chrome items inside a list or table; (items seen, items dropped). A table row with an empty first cell
    goes with the row before it (the rest of a dropped "Cite as" row)."""
    seen = dropped = 0
    kept, last_dropped = [], False
    for kid in node.kids:
        if isinstance(kid, str):
            kept.append(kid)
            continue
        if kid.tag in CONTAINERS:
            s, d = _prune_items(kid, repeated)
            seen, dropped = seen + s, dropped + d
            if _words(kid.text()):
                kept.append(kid)
            continue
        seen += 1
        first = next((k for k in kid.kids if isinstance(k, _Node)), None)
        continuation = kid.tag == "tr" and first is not None and not _words(first.text())
        if _is_chrome(kid, repeated) or (continuation and last_dropped):
            dropped += 1
            last_dropped = True
            continue
        last_dropped = False
        kept.append(kid)
    node.kids = kept
    return seen, dropped


def _leaves(node: _Node):
    """The blocks the pruning weighs: paragraphs and list items or table rows, not headings."""
    for kid in node.kids:
        if isinstance(kid, _Node):
            if kid.tag in CONTAINERS or kid.tag == "#root":
                yield from _leaves(kid)
            elif not HEADING.fullmatch(kid.tag):
                yield kid


def _prune_chrome(root: _Node) -> None:
    """Drops the furniture of a page that had no <article>/<main>. Structure first (empty and link-heavy blocks,
    breadcrumbs, sections that are mostly furniture), a short list of phrases second; a section under a furniture
    heading ("Submission history") goes with it, and a heading left with nothing under it goes too."""
    blocks = [k for k in root.kids if isinstance(k, _Node)]
    lines = Counter(_words(b.text()) for b in _leaves(root))
    repeated = frozenset(t for t, n in lines.items() if n > 1 and len(t) <= REPEATED_MAX)
    seen: dict[int, tuple[int, int]] = {}
    for b in blocks:
        if b.tag in CONTAINERS:
            seen[id(b)] = _prune_items(b, repeated)
        elif HEADING.fullmatch(b.tag):
            seen[id(b)] = (0, 0)
        else:
            seen[id(b)] = (1, int(_is_chrome(b, repeated)))
    gone: set[int] = {id(b) for b in blocks if b.tag not in CONTAINERS and not HEADING.fullmatch(b.tag) and seen[id(b)][1]}
    gone |= {id(b) for b in blocks if b.tag in CONTAINERS and not _words(b.text())}

    def section(at: int) -> list[_Node]:
        level = int(blocks[at].tag[1])
        out = []
        for b in blocks[at + 1:]:
            if HEADING.fullmatch(b.tag) and int(b.tag[1]) <= level:
                break
            out.append(b)
        return out

    for at, b in enumerate(blocks):
        if not HEADING.fullmatch(b.tag) or id(b) in gone:
            continue
        text = _words(b.text())
        under = section(at)
        # its own blocks, up to the next heading of any level: a panel of toggles and link lists with a stray label
        own = list(itertools.takewhile(lambda u: not HEADING.fullmatch(u.tag), under))
        total, junk = sum(seen[id(u)][0] for u in own), sum(seen[id(u)][1] for u in own)
        left = sum(len(_words(u.text())) for u in own if id(u) not in gone)
        if BREADCRUMB.search(text) and len(text) <= CHROME_MAX:
            gone.add(id(b))
        elif len(text) <= CHROME_MAX and CHROME.search(text):
            gone.add(id(b))
            gone |= {id(u) for u in under}
        elif total >= 3 and junk >= 0.6 * total and left < PANEL_TEXT:
            gone.add(id(b))
            gone |= {id(u) for u in own}
    for at in range(len(blocks) - 1, -1, -1):  # from the end, so a heading over emptied subsections empties too
        b = blocks[at]
        if HEADING.fullmatch(b.tag) and id(b) not in gone:
            under = section(at)
            if under and all(id(u) in gone or HEADING.fullmatch(u.tag) for u in under) and all(id(u) in gone for u in under if HEADING.fullmatch(u.tag)):
                gone.add(id(b))
    root.kids = [k for k in root.kids if isinstance(k, str) or id(k) not in gone]


def _label(text: str) -> _Node:
    node = _Node("h2", cls="sbw-reader-label")
    node.kids.append(text)
    return node


def _strip_label(node: _Node) -> str:
    """Removes a glued "Title:" / "Authors:" / "Abstract:" from the start of a block; returns the label or ''."""
    for at, kid in enumerate(node.kids):
        if isinstance(kid, str):
            if not kid.strip():
                continue
            found = LABEL.match(kid)
            if found:
                node.kids[at] = kid[found.end():]
                return found.group(1)
            return ""
        return _strip_label(kid) if kid.tag in ("strong", "b", "em", "span") else ""
    return ""


def _tidy(root: _Node, title: str, byline: str) -> None:
    """Every page: the block repeating the title goes (the header shows it), glued field labels go, an abstract gets a
    small "Abstract" label instead of a quote."""
    out = []
    blocks = 0
    for kid in root.kids:
        if isinstance(kid, str):
            out.append(kid)
            continue
        blocks += 1
        # near the top only: a site may print the title twice (a kicker and the heading); later it is a quotation
        if blocks <= 8 and kid.tag in ("p", "h1", "h2", "h3") and _same(kid.text(), title):
            continue
        if _words(kid.text()).lower() == "abstract" and HEADING.fullmatch(kid.tag):
            out.append(_label("Abstract"))
            continue
        label = _strip_label(kid) if kid.tag in ("p", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6") else ""
        if label.startswith("Author") and byline:
            continue
        if label == "Abstract":
            out.append(_label("Abstract"))
            if kid.tag == "blockquote":
                inner = [k for k in kid.kids if not isinstance(k, str) or k.strip()]
                if inner and all(isinstance(k, _Node) and k.tag == "p" for k in inner):
                    out.extend(inner)
                    continue
                kid = _Node("p", kids=kid.kids)
        out.append(kid)
    root.kids = out


def _flip(authors: list[str]) -> list[str]:
    """"Last, First" names turned round when every entry has exactly one comma (citation_author's form)."""
    names = [_words(a) for a in authors if a.strip()]
    if names and all(n.count(",") == 1 for n in names):
        names = [" ".join(reversed([p.strip() for p in n.split(",")])) for n in names]
    return names


def _names(authors: list[str]) -> str:
    """The byline: names in natural order, at most six then "et al."."""
    names = _flip(authors)
    return ", ".join(names[:6]) + (" et al." if len(names) > 6 else "")


def reader(url: str, page: bytes, kind_charset: str = "") -> dict | None:
    """{title, byline, html, math?} of a page's main text, or None when it has too little text to show."""
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
    candidates = parser.done_zones + [(tag, "".join(z)) for tag, z in parser.zones]
    tag, best = max(candidates, key=lambda c: _text_length(c[1]), default=("", ""))
    zoned = _text_length(best) >= MIN_TEXT
    body = best if zoned else "".join(parser.out)
    meta = parser.meta
    title = html.unescape((meta.get("citation_title") or meta.get("og:title") or [parser.title.strip()])[0] or url).strip()
    site = html.unescape((meta.get("og:site_name") or [""])[0]).strip()
    if site:  # "Story | Quanta Magazine": the header shows the story; the site's name is in the address line
        title = re.sub(rf"\s+[|\-–—·:]\s+{re.escape(site)}$", "", title) or title
    byline = _names(meta.get("citation_author") or meta.get("author") or [])
    root = _tree(body)
    # An <article> is the site's own choice of text and is kept whole; the whole body, or a <main> (often the page
    # less its header, arXiv's holds every sidebar), needs its furniture taken off.
    if not zoned or tag != "article":
        _prune_chrome(root)
    _tidy(root, title, byline)
    body = root.html()
    # drop the empty tags a stripped page leaves behind
    for _ in range(3):
        body = re.sub(r"<(\w+)>\s*</\1>", "", body)
    if _text_length(body) < MIN_TEXT:
        return None
    return {"title": title, "byline": byline, "html": body.strip(), **({"math": True} if parser.has_math else {})}


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
    arxiv = arxiv_of(url) or ((radar_api.arxiv_id(doi[len(ARXIV_DOI):]), "abs") if doi and doi.startswith(ARXIV_DOI) else None)
    if arxiv and arxiv[0]:
        found = _arxiv(url, arxiv[0], arxiv[1], prefer, get)
        if found:
            return found
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


# --- arXiv links ---------------------------------------------------------------------------------------------------
# An arXiv link answers the paper itself: the API's metadata (clean title, authors in order, dates, version), the
# abstract page's subject names and its "HTML (experimental)" link, and for /html/ the LaTeXML full text around them.

ARXIV_HOSTS = ("arxiv.org", "export.arxiv.org")
ARXIV_API = "http://export.arxiv.org/api/query?id_list={}"
ARXIV_DOI = "10.48550/arxiv."
ARXIV_DAYS = 1
ATOM = {"a": "http://www.w3.org/2005/Atom", "arxiv": "http://arxiv.org/schemas/atom"}
MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split()
# TeX accents in arXiv titles, names and abstracts ("F\'elisaz"), as combining marks; letters LaTeX writes as commands.
ACCENTS = {"'": "́", "`": "̀", "^": "̂", '"': "̈", "~": "̃", "=": "̄", ".": "̇",
           "u": "̆", "v": "̌", "H": "̋", "c": "̧", "k": "̨", "r": "̊"}
LETTERS = {"ss": "ß", "aa": "å", "AA": "Å", "ae": "æ", "AE": "Æ", "oe": "œ", "OE": "Œ", "o": "ø", "O": "Ø", "l": "ł",
           "L": "Ł", "i": "ı"}
SIGN_ACCENT = re.compile(r"\{?\\(['`^\"~=.])\s*\{?\\?([A-Za-z])\}?\}?")
WORD_ACCENT = re.compile(r"\{?\\([uvHckr])(?:\{\\?([A-Za-z])\}|\s+([A-Za-z]))\}?")
LETTER = re.compile(r"\{\\(ss|aa|AA|ae|AE|oe|OE|[oOlLi])\}|\\(ss|aa|AA|ae|AE|oe|OE|[oOlLi])(?![A-Za-z])\s?")
MATH = re.compile(r"(\$\$.+?\$\$|\$[^$]+\$)", re.S)


def arxiv_of(url: str) -> tuple[str, str] | None:
    """(arXiv id, "abs" | "pdf" | "html") for arxiv.org/abs|pdf|html/<id>[vN][.pdf], new or old-style ids."""
    try:
        parsed = urllib.parse.urlparse(url)
    except ValueError:
        return None
    if (parsed.hostname or "").lower().removeprefix("www.") not in ARXIV_HOSTS:
        return None
    found = re.fullmatch(r"/(abs|pdf|html)/(.+?)(?:\.pdf)?/?", parsed.path)
    arxiv = radar_api.arxiv_id(found.group(2)) if found else None
    return (arxiv, found.group(1)) if arxiv else None


def tex_text(text: str) -> str:
    """arXiv's TeX for letters turned into letters, whitespace collapsed; $…$ is left for the client's KaTeX."""
    def letters(part: str) -> str:
        part = SIGN_ACCENT.sub(lambda m: m.group(2) + ACCENTS[m.group(1)], part)
        part = WORD_ACCENT.sub(lambda m: (m.group(2) or m.group(3)) + ACCENTS[m.group(1)], part)
        return LETTER.sub(lambda m: LETTERS[m.group(1) or m.group(2)], part)
    parts = MATH.split(text or "")
    out = "".join(part if at % 2 else letters(part) for at, part in enumerate(parts))
    return unicodedata.normalize("NFC", _words(out))


def _day(stamp: str) -> str:
    """"28 Jul 2026" from an ISO stamp, without the locale's month names."""
    found = re.match(r"(\d{4})-(\d{2})-(\d{2})", stamp or "")
    return f"{int(found.group(3))} {MONTHS[int(found.group(2)) - 1]} {found.group(1)}" if found else ""


def _arxiv_api(arxiv: str, get) -> dict | None:
    """The paper as the arXiv API (Atom) has it, or None when it is away or does not know the id."""
    try:
        answer = get(ARXIV_API.format(arxiv), 2_000_000, "application/atom+xml")
    except (OSError, Refused):
        return None
    if answer.status != 200:
        return None
    try:
        entry = ET.fromstring(answer.body).find("a:entry", ATOM)
    except ET.ParseError:
        return None
    if entry is None or "/api/errors" in entry.findtext("a:id", "", ATOM) or not entry.findtext("a:title", "", ATOM).strip():
        return None
    version = re.search(r"(v\d+)$", entry.findtext("a:id", "", ATOM).strip())
    primary = entry.find("arxiv:primary_category", ATOM)
    published, updated = _day(entry.findtext("a:published", "", ATOM)), _day(entry.findtext("a:updated", "", ATOM))
    return {
        "title": tex_text(entry.findtext("a:title", "", ATOM)),
        "authors": [tex_text(a.findtext("a:name", "", ATOM)) for a in entry.findall("a:author", ATOM)],
        "abstract": tex_text(entry.findtext("a:summary", "", ATOM)),
        "version": version.group(1) if version else "",
        "submitted": published,
        "revised": updated if updated != published else "",
        "codes": [c.get("term", "") for c in entry.findall("a:category", ATOM) if c.get("term")],
        "primary": primary.get("term", "") if primary is not None else "",
        "doi": (entry.findtext("arxiv:doi", "", ATOM) or "").strip(),
        "comment": tex_text(entry.findtext("arxiv:comment", "", ATOM)),
    }


def _arxiv_abs(arxiv: str, get) -> dict | None:
    """What the abstract page adds: subject names, the HTML full text's address (only papers that have one), and, when
    the API is away, citation_* meta tags and the dateline."""
    url = f"https://arxiv.org/abs/{arxiv}"
    try:
        answer = get(url)
    except (OSError, Refused):
        return None
    if answer.status != 200:
        return None
    page = answer.body.decode("utf-8", "replace")
    parser = _Reader(url)
    try:
        parser.feed(page)
    except Exception:  # noqa: BLE001 - a broken page still has its head
        pass
    meta = parser.meta
    cell = re.search(r'class="tablecell subjects"[^>]*>(.*?)</td>', page, re.S)
    subjects = []
    for item in html.unescape(re.sub(r"<[^>]+>", "", cell.group(1))).split(";") if cell else []:
        found = re.fullmatch(r"(.+?)\s*\(([^()]+)\)", _words(item))
        if found:
            subjects.append({"code": found.group(2), "name": found.group(1)})
    full = re.search(r'href="([^"]*/html/[^"]+)"[^>]*>\s*HTML', page)
    doi = re.search(r'class="tablecell doi"[^>]*>.*?href="https?://(?:dx\.)?doi\.org/([^"]+)"', page, re.S)
    submitted = re.search(r"\[Submitted on ([^(\]]+?)\s*[(\]]", page)
    revised = re.search(r"last revised ([^(]+?)\s*\(this version, (v\d+)\)", page)
    return {
        "title": tex_text(html.unescape((meta.get("citation_title") or [""])[0])),
        "authors": _flip([tex_text(html.unescape(a)) for a in meta.get("citation_author") or []]),
        "abstract": tex_text(html.unescape((meta.get("citation_abstract") or [""])[0])),
        "version": revised.group(2) if revised else ("v1" if submitted else ""),
        "submitted": _words(submitted.group(1)) if submitted else "",
        "revised": _words(revised.group(1)) if revised else "",
        "subjects": subjects,
        "html": urllib.parse.urljoin(url, html.unescape(full.group(1))) if full else "",
        "doi": urllib.parse.unquote(doi.group(1)) if doi else "",
    }


def arxiv_paper(arxiv: str, get=fetch) -> dict | None:
    """One arXiv paper (API first, the abstract page for what it lacks), kept a day; None when neither answers."""
    path = folder("arxiv") / f"{hashlib.sha1(arxiv.encode()).hexdigest()}.json"
    if _fresh(path, ARXIV_DAYS * 86400):
        try:
            return json.loads(path.read_text()) or None
        except (OSError, ValueError):
            pass
    api, page = _arxiv_api(arxiv, get), _arxiv_abs(arxiv, get)
    if not (api or {}).get("title") and not (page or {}).get("title"):
        return None  # arXiv away or no such paper: not remembered
    api, page = api or {}, page or {}
    names = {s["code"]: s["name"] for s in page.get("subjects", [])}
    codes = api.get("codes") or [s["code"] for s in page.get("subjects", [])]
    primary = api.get("primary") or (codes[0] if codes else "")
    codes = sorted(codes, key=lambda code: code != primary)  # the primary subject first, the rest as listed
    paper = {
        "arxiv": arxiv,
        "title": api.get("title") or page["title"],
        "authors": api.get("authors") or page.get("authors", []),
        "abstract": api.get("abstract") or page.get("abstract", ""),
        "version": api.get("version") or page.get("version", ""),
        "submitted": api.get("submitted") or page.get("submitted", ""),
        "revised": api["revised"] if api else page.get("revised", ""),
        "subjects": [{"code": code, "name": names.get(code, ""), "primary": code == primary} for code in codes],
        "doi": api.get("doi") or page.get("doi") or f"10.48550/arXiv.{arxiv}",
        "comment": api.get("comment", ""),
        "html": page.get("html", ""),
    }
    path.write_text(json.dumps(paper))
    return paper


def _arxiv(url: str, arxiv: str, kind: str, prefer: str | None, get) -> dict | None:
    """The paper answer for an arXiv link; None to treat it as an ordinary page. A /pdf/ link stays the PDF unless the
    reader is asked for; /html/ is the full text read from its LaTeXML <article>, with the paper's header."""
    if kind == "pdf" and prefer != "reader":
        return None
    paper = arxiv_paper(arxiv, get)
    if not paper:
        return None
    links = [{"label": "PDF", "url": f"https://arxiv.org/pdf/{arxiv}", "kind": "pdf"}]
    answer = {"mode": "reader", "url": url, "title": paper["title"], "byline": _names(paper["authors"]),
              "abstract": paper["abstract"], "html": "", "source": "arxiv", "math": True,
              "paper": {**{k: paper[k] for k in ("arxiv", "version", "submitted", "revised", "subjects", "doi", "comment")}, "authors": _flip(paper["authors"])},
              "links": links}
    if kind == "html":
        read = None
        try:
            full = get(url)
            if full.status < 400 and not _is_pdf(full):
                read = reader(full.url or url, full.body[:PAGE_MAX_BYTES], full.headers.get("content-type", ""))
        except (OSError, Refused):
            pass
        if read:
            answer["html"] = read["html"]
            del answer["abstract"]  # the full text has its own
            links.append({"label": "Abstract", "url": f"https://arxiv.org/abs/{arxiv}", "kind": "reader"})
        return answer
    if paper["html"]:
        links.append({"label": "Full text", "url": paper["html"], "kind": "reader"})
    return answer


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
