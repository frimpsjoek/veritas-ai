"""web_page: the link panel's server half, GET /web/page and GET /web/pdf (spec 022)."""
from __future__ import annotations

import json
from pathlib import Path
import sqlite3

import pytest

import kb
import pdf_route
import site_icons
import web_page
from web_page import Response

DOI = "10.1021/acsnano.6c11666"
ARTICLE = ("<p>" + "Triangulene honeycomb lattices host low-energy spin excitations that we follow here. " * 6 + "</p>")
WORK_GREEN = {
    "title": "Low Energy Excitations in a [4]Triangulene Honeycomb Antiferromagnet",
    "authorships": [{"author": {"display_name": "A. Author"}}, {"author": {"display_name": "B. Author"}}],
    "abstract_inverted_index": {"Spins": [0], "flip": [1], "here.": [2]},
    "best_oa_location": {"is_oa": True, "pdf_url": "https://arxiv.org/pdf/2301.06171", "version": "submittedVersion",
                         "source": {"display_name": "arXiv (Cornell University)"}},
    "locations": [],
    "primary_location": {"landing_page_url": "https://pubs.acs.org/doi/10.1021/acsnano.6c11666"},
}
WORK_CLOSED = {**WORK_GREEN, "best_oa_location": None, "locations": [{"is_oa": False, "pdf_url": "https://pubs.acs.org/x.pdf"}]}


@pytest.fixture()
def web(tmp_path, monkeypatch):
    """A fake web: {url: Response}; every other URL raises like an unreachable site. Records the URLs asked."""
    monkeypatch.setattr(kb, "HOME", tmp_path)
    monkeypatch.setattr(site_icons, "public_host", lambda host: None)
    monkeypatch.setattr(web_page, "library_pdf", lambda doi: None)
    pages: dict[str, Response] = {}
    calls: list[str] = []

    def get(url, limit=web_page.PAGE_MAX_BYTES, accept=""):
        calls.append(url)
        if url not in pages:
            raise OSError("unreachable")
        return pages[url]
    return pages, calls, get


def html_page(url, body, headers=None, status=200):
    return Response(url, status, {"content-type": "text/html; charset=utf-8", **(headers or {})},
                    f"<html><head><title>T</title></head><body>{body}</body></html>".encode())


def openalex_url(doi):
    return (f"https://api.openalex.org/works/doi:{doi}?select=title,display_name,authorships,abstract_inverted_index,"
            "best_oa_location,locations,primary_location")


# --- G1 ordinary pages ---------------------------------------------------------------------------------------------

def test_a_page_that_allows_frames_is_framed(web):
    pages, _, get = web
    pages["https://ok.example/a"] = html_page("https://ok.example/a", ARTICLE)
    answer = web_page.page("https://ok.example/a", get=get)
    assert answer == {"mode": "frame", "url": "https://ok.example/a", "title": "T"}


@pytest.mark.parametrize("headers", [{"x-frame-options": "SAMEORIGIN"}, {"x-frame-options": "DENY"},
                                     {"content-security-policy": "default-src 'self'; frame-ancestors 'self'"}])
def test_a_page_that_refuses_frames_gets_the_reader_view(web, headers):
    pages, _, get = web
    body = ('<nav><ul><li>Menu<li>More</ul></nav><script>alert(1)</script>'
            f'<article><h1>Title</h1>{ARTICLE}<p onclick="x()">See <a href="/next" onmouseover="y()">next</a>'
            ' and <a href="javascript:z()">this</a>.</p></article><footer>foot</footer>')
    pages["https://closed.example/a"] = html_page("https://closed.example/a", body, headers)
    answer = web_page.page("https://closed.example/a", get=get)
    assert answer["mode"] == "reader"
    text = answer["html"]
    assert "Triangulene" in text and "Menu" not in text and "foot" not in text
    assert "<script" not in text and "alert" not in text and "onclick" not in text and "onmouseover" not in text
    assert '<a href="https://closed.example/next">next</a>' in text, "links are made absolute"
    assert "javascript:" not in text


def test_prefer_reader_skips_the_frame(web):
    pages, _, get = web
    pages["https://ok.example/a"] = html_page("https://ok.example/a", ARTICLE)
    assert web_page.page("https://ok.example/a", "reader", get=get)["mode"] == "reader"


def test_an_unclosed_tag_inside_a_skipped_block_does_not_swallow_the_page(web):
    pages, _, get = web
    pages["https://ok.example/u"] = html_page("https://ok.example/u", f"<nav><ul><li>MENUITEM<li>two</nav>{ARTICLE}",
                                              {"x-frame-options": "DENY"})
    answer = web_page.page("https://ok.example/u", get=get)
    assert answer["mode"] == "reader" and "Triangulene" in answer["html"] and "MENUITEM" not in answer["html"]


def test_a_pdf_link_is_a_pdf(web):
    pages, _, get = web
    pages["https://files.example/p.pdf"] = Response("https://files.example/p.pdf", 200, {"content-type": "application/pdf"}, b"%PDF-1.4")
    assert web_page.page("https://files.example/p.pdf", get=get) == {"mode": "pdf", "url": "https://files.example/p.pdf", "title": "p.pdf"}


def test_bot_protection_is_blocked_with_its_reason(web):
    pages, _, get = web
    pages["https://pub.example/a"] = Response("https://pub.example/a", 403, {"cf-mitigated": "challenge", "server": "cloudflare"}, b"")
    answer = web_page.page("https://pub.example/a", get=get)
    assert answer["mode"] == "blocked" and answer["reason"] == web_page.BOT


def test_a_page_with_no_text_is_blocked(web):
    pages, _, get = web
    pages["https://app.example/"] = html_page("https://app.example/", "<div id=root></div><script>boot()</script>",
                                              {"x-frame-options": "DENY"})
    answer = web_page.page("https://app.example/", get=get)
    assert answer["mode"] == "blocked" and answer["reason"] == web_page.NO_TEXT


def test_an_unreachable_or_slow_site_is_blocked(web):
    _, _, get = web
    assert web_page.page("https://nowhere.example/", get=get)["mode"] == "blocked"

    def slow(url, limit=0, accept=""):
        raise TimeoutError("timed out")
    assert web_page.page("https://slow.example/", get=slow)["reason"] == web_page.SLOW


@pytest.mark.parametrize("url", ["http://127.0.0.1:27190/status", "http://localhost/", "file:///etc/passwd",
                                 "http://10.0.0.1/", "javascript:alert(1)"])
def test_private_and_odd_links_are_refused_without_a_fetch(url, tmp_path, monkeypatch):
    monkeypatch.setattr(kb, "HOME", tmp_path)
    calls = []
    answer = web_page.page(url, get=lambda *a, **k: calls.append(a))
    assert answer["mode"] == "blocked" and answer["reason"] == web_page.NOT_PUBLIC and not calls


def test_a_redirect_to_a_private_address_is_refused():
    with pytest.raises(web_page.Refused):
        web_page._Checked().redirect_request(None, None, 302, "Found", {}, "http://192.168.1.1/admin")


# --- G2 paper links ------------------------------------------------------------------------------------------------

@pytest.mark.parametrize("url", [f"https://doi.org/{DOI}", f"https://dx.doi.org/{DOI}", f"https://www.doi.org/{DOI.upper()}",
                                 f"https://pubs.acs.org/doi/{DOI}", f"https://pubs.acs.org/doi/abs/{DOI}?ref=x",
                                 "https://doi.org/10.1021%2Facsnano.6c11666"])
def test_doi_forms(url):
    assert web_page.doi_of(url) == DOI


def test_not_a_doi():
    assert web_page.doi_of("https://arxiv.org/abs/2301.06171") is None


def test_an_open_access_copy_comes_before_the_publisher(web):
    pages, calls, get = web
    pages[openalex_url(DOI)] = Response("x", 200, {}, json.dumps(WORK_GREEN).encode())
    answer = web_page.page(f"https://doi.org/{DOI}", get=get)
    assert answer == {"mode": "pdf", "url": "https://arxiv.org/pdf/2301.06171", "title": WORK_GREEN["title"],
                      "source": "open access", "version": "submitted", "where": "arXiv (Cornell University)"}
    assert not any("doi.org/10" in c and "openalex" not in c for c in calls), "the publisher is never asked"
    n = len(calls)
    web_page.page(f"https://doi.org/{DOI}", get=get)
    assert len(calls) == n, "the OpenAlex answer is kept"


def test_the_library_copy_comes_first(web, monkeypatch):
    pages, calls, get = web
    monkeypatch.setattr(web_page, "library_pdf", lambda doi: ("ATTA1234", "My copy") if doi == DOI else None)
    answer = web_page.page(f"https://pubs.acs.org/doi/{DOI}", get=get)
    assert answer == {"mode": "pdf", "url": f"https://doi.org/{DOI}", "title": "My copy", "source": "library"}
    assert not calls


def test_a_closed_paper_shows_its_abstract_and_the_publisher_link(web):
    pages, _, get = web
    pages[openalex_url(DOI)] = Response("x", 200, {}, json.dumps(WORK_CLOSED).encode())
    answer = web_page.page(f"https://doi.org/{DOI}", get=get)
    assert answer["mode"] == "reader" and answer["source"] == "openalex"
    # the same paper shape as an arXiv answer: the abstract under its label, the way out as a button in the header
    assert answer["abstract"] == "Spins flip here." and "Only the abstract is open." in answer["html"]
    assert answer["links"] == [{"label": "Publisher's page", "url": "https://pubs.acs.org/doi/10.1021/acsnano.6c11666", "kind": "page"}]
    assert answer["byline"] == "A. Author, B. Author"


def test_openalex_away_falls_back_to_the_publisher(web):
    pages, calls, get = web
    pages[f"https://doi.org/{DOI}"] = Response(f"https://pubs.acs.org/doi/{DOI}", 403, {"cf-mitigated": "challenge"}, b"")
    answer = web_page.page(f"https://doi.org/{DOI}", get=get)
    assert answer["mode"] == "blocked" and answer["reason"] == web_page.BOT


def test_library_pdf_query(tmp_path, monkeypatch):
    """The SQL against Zotero's schema: the DOI field (any case), a PDF child attachment, not in the trash."""
    db = sqlite3.connect(":memory:")
    db.executescript("""
        CREATE TABLE items(itemID INTEGER PRIMARY KEY, key TEXT);
        CREATE TABLE fields(fieldID INTEGER PRIMARY KEY, fieldName TEXT);
        CREATE TABLE itemDataValues(valueID INTEGER PRIMARY KEY, value TEXT);
        CREATE TABLE itemData(itemID INT, fieldID INT, valueID INT);
        CREATE TABLE itemAttachments(itemID INT, parentItemID INT, contentType TEXT, linkMode INT, path TEXT);
        CREATE TABLE deletedItems(itemID INT);
        INSERT INTO fields VALUES (1, 'title'), (2, 'DOI');
        INSERT INTO items VALUES (1, 'PAPR1234'), (2, 'ATTA1234'), (3, 'TRSH1234'), (4, 'HTML1234');
        INSERT INTO itemDataValues VALUES (1, 'A paper'), (2, '10.1021/ACSNANO.6C11666');
        INSERT INTO itemData VALUES (1, 1, 1), (1, 2, 2);
        INSERT INTO itemAttachments VALUES (3, 1, 'application/pdf', 0, 'storage:old.pdf'),
                                           (4, 1, 'text/html', 0, 'storage:x.html'), (2, 1, 'application/pdf', 0, 'storage:x.pdf');
        INSERT INTO deletedItems VALUES (3);
    """)
    zdir = tmp_path / "Zotero"
    zdir.mkdir()
    monkeypatch.setattr(web_page.zotero, "ZOTERO", zdir)
    monkeypatch.setattr(web_page.zotero, "snapshot", lambda *a, **k: db)
    monkeypatch.setattr(pdf_route, "resolve", lambda key: tmp_path / f"{key}.pdf")
    assert web_page.library_pdf(DOI) == ("ATTA1234", "A paper")
    assert web_page.library_pdf("10.1/none") is None


# --- G3 /web/pdf ---------------------------------------------------------------------------------------------------

def test_pdf_file_fetches_once_and_refuses_non_pdfs(web):
    pages, calls, get = web
    pages["https://files.example/p.pdf"] = Response("https://files.example/p.pdf", 200, {}, b"%PDF-1.4 body")
    pages["https://files.example/not.pdf"] = Response("https://files.example/not.pdf", 200, {}, b"<html>")
    path = web_page.pdf_file("https://files.example/p.pdf", get=get)
    assert path.read_bytes() == b"%PDF-1.4 body"
    n = len(calls)
    assert web_page.pdf_file("https://files.example/p.pdf", get=get) == path and len(calls) == n
    with pytest.raises(ValueError, match="not a PDF"):
        web_page.pdf_file("https://files.example/not.pdf", get=get)


def test_pdf_file_for_a_doi_uses_the_open_access_copy(web):
    pages, _, get = web
    pages[openalex_url(DOI)] = Response("x", 200, {}, json.dumps(WORK_GREEN).encode())
    pages["https://arxiv.org/pdf/2301.06171"] = Response("https://arxiv.org/pdf/2301.06171", 200, {}, b"%PDF-1.5 arxiv")
    assert web_page.pdf_file(f"https://doi.org/{DOI}", get=get).read_bytes() == b"%PDF-1.5 arxiv"


def test_pdf_file_for_a_doi_in_the_library_is_the_library_file(web, monkeypatch, tmp_path):
    _, calls, get = web
    mine = tmp_path / "mine.pdf"
    mine.write_bytes(b"%PDF-1.4 mine")
    monkeypatch.setattr(web_page, "library_pdf", lambda doi: ("ATTA1234", "t"))
    monkeypatch.setattr(pdf_route, "resolve", lambda key: mine)
    assert web_page.pdf_file(f"https://doi.org/{DOI}", get=get) == mine and not calls


# --- a cleaner reader view (2026-10-29) ----------------------------------------------------------------------------

ARXIV_ABS = (Path(__file__).parent / "fixtures" / "web_page" / "arxiv-abs-2607.25690.html").read_bytes()
CHROME = ["Condensed Matter &gt; Mesoscale", "View a PDF of the paper", "View PDF", "HTML (experimental)",
          "Submission history", "Full-text links", "Current browse context", "References &amp; Citations",
          "Loading...", "Toggle", "(What is", "Bookmark", "Cite as", "Change to browse by",
          "Which authors of this paper", "Disable MathJax", "F\\'elisaz", "Title:", "Authors:", "Abstract:"]


def test_a_page_without_an_article_loses_its_chrome_and_keeps_its_text():
    """The real arXiv abstract page (fetched once, 2026-10-28): no <article> or <main>, so the whole body is read and
    the menus, toggles, link lists and labels around the abstract have to go structurally."""
    read = web_page.reader("https://arxiv.org/abs/2607.25690", ARXIV_ABS, "text/html; charset=utf-8")
    body = read["html"]
    for phrase in CHROME:
        assert phrase not in body, phrase
    assert read["title"] == "First-Principles Wannier Representation of Proximity Effects"
    assert "First-Principles Wannier Representation" not in body, "the title shows once, in the header"
    assert read["byline"] == "Yaroslav Zhumagulov, Johan Félisaz, Stepan S. Tsirkin, Denis Kochan, Oleg V. Yazyev"
    assert "Proximity effects in layered heterostructures" in body and "correlated-phase calculations." in body
    assert '<h2 class="sbw-reader-label">Abstract</h2><p>Proximity effects' in body, "a small label, not a blockquote"
    assert "<blockquote>" not in body
    assert "Mesoscale and Nanoscale Physics (cond-mat.mes-hall)" in body, "the subjects row is content"


BLOG = """<header><a href="/">Home</a> <a href="/about">About</a></header>
<article><h1>Voles of the northern meadows</h1>
<p>By Ana Field</p>
<p>Field voles dig shallow runways under the grass, and in a wet spring those runways flood within hours.</p>
<p>See <a href="/maps">the maps</a>.</p>
<ul><li><a href="/a">One study</a></li><li><a href="/b">Another study</a></li></ul>
<p>Toggle the layers on the map to compare the two winters; the difference is clearest along the river.</p>
<p>Loading the burrows by hand took us three seasons, and the counts below are the result of that work.</p>
</article>"""


def test_an_article_keeps_every_paragraph():
    read = web_page.reader("https://blog.example/voles", f"<html><head><title>Voles of the northern meadows</title></head><body>{BLOG}</body></html>".encode())
    body = read["html"]
    for kept in ["By Ana Field", "Field voles dig", '<a href="https://blog.example/maps">the maps</a>', "One study",
                 "Another study", "Toggle the layers", "Loading the burrows"]:
        assert kept in body, kept
    assert "Voles of the northern meadows" not in body, "the heading repeating the title goes"


def test_a_page_without_an_article_keeps_its_paragraphs_and_drops_link_lists():
    page = ("<div class=menu><a href=/a>Alpha</a> | <a href=/b>Beta</a> | <a href=/c>Gamma</a></div>"
            "<div class=post><h2>Winter counts</h2>"
            "<div>Field voles dig shallow runways under the grass, and in a wet spring those runways flood.</div>"
            "<p>See <a href='/maps'>the maps</a> for where we counted, and the table for how many we found.</p>"
            "<p>Toggle the layers on the map to compare the two winters; the river shows it most clearly.</p>"
            "<p>" + "We counted every burrow along the transects twice, once in each winter. " * 3 + "</p></div>"
            "<div><ul><li><a href=/x>Privacy</a></li><li><a href=/y>Terms</a></li><li><a href=/z>Contact</a></li></ul></div>")
    read = web_page.reader("https://blog.example/c", f"<html><body>{page}</body></html>".encode())
    body = read["html"]
    for kept in ["Winter counts", "Field voles dig", "the maps", "Toggle the layers", "We counted every burrow"]:
        assert kept in body, kept
    for gone in ["Alpha", "Privacy", "Terms"]:
        assert gone not in body, gone
    assert "<p>Field voles dig" in body, "loose text in a div becomes its own paragraph"


def test_money_is_not_math_but_mathml_is():
    prices = "<article><p>" + "Tickets cost $5 and $10 at the door, and the late show is cheaper on weekdays. " * 4 + "</p></article>"
    read = web_page.reader("https://shop.example/", f"<html><body>{prices}</body></html>".encode())
    assert "$5 and $10" in read["html"] and not read.get("math")
    formula = ('<article><p>' + "The energy of the state follows from the equation below, as derived above. " * 3 +
               '<math alttext="E=mc^{2}" display="inline"><mi>E</mi><annotation encoding="application/x-tex">E=mc^{2}'
               '</annotation></math> holds.</p></article>')
    read = web_page.reader("https://physics.example/", f"<html><body>{formula}</body></html>".encode())
    assert "$E=mc^{2}$ holds." in read["html"] and read["math"] is True


def test_a_byline_of_last_first_names_reads_first_last():
    def byline(*authors):
        metas = "".join(f'<meta name="citation_author" content="{a}">' for a in authors)
        return web_page.reader("https://x.example/", f"<html><head>{metas}</head><body><article>{ARTICLE}</article></body></html>".encode())["byline"]
    assert byline("Curie, Marie", "Bohr, Niels") == "Marie Curie, Niels Bohr"
    assert byline("Marie Curie", "Bohr, Niels") == "Marie Curie, Bohr, Niels", "flipped only when every name has one comma"
    assert byline(*[f"Last{i}, First{i}" for i in range(8)]) == ", ".join(f"First{i} Last{i}" for i in range(6)) + " et al."


def test_a_title_with_the_site_name_still_counts_as_repeated():
    """Quanta (2026-10-29): <title> "Story | Quanta Magazine", and the story's name twice at the top of its text."""
    head = '<title>How Spiders Spin Silk | Field Notes</title><meta property="og:site_name" content="Field Notes">'
    page = f"<html><head>{head}</head><body><main><p>How Spiders Spin Silk</p><h1>How Spiders Spin Silk</h1>{ARTICLE}</main></body></html>"
    read = web_page.reader("https://notes.example/silk", page.encode())
    assert read["title"] == "How Spiders Spin Silk", "the site's name is not part of the title"
    assert "How Spiders Spin Silk" not in read["html"]
