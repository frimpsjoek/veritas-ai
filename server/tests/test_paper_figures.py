import paper_figures as pf


def test_springer_nature_figure_address_follows_the_doi():
    assert pf.springer_figure("10.1038/s41524-026-02351-z").endswith("/art%3A10.1038%2Fs41524-026-02351-z/MediaObjects/41524_2026_2351_Fig1_HTML.png")
    assert pf.springer_figure("10.1007/s11224-026-02844-z").endswith("/MediaObjects/11224_2026_2844_Fig1_HTML.png")
    assert pf.springer_figure("10.1021/acs.jctc.6c01446") is None


def test_arxiv_id_from_the_field_or_an_arxiv_link_only():
    assert pf.arxiv_id("2509.08418v2", None) == "2509.08418"
    assert pf.arxiv_id(None, "https://arxiv.org/pdf/2509.08418") == "2509.08418"
    assert pf.arxiv_id(None, "https://doi.org/10.1021/2509.08418") is None


def test_preview_image_is_absolute_and_skips_logos_and_covers():
    page = "https://link.example.org/article/1"
    assert pf.preview_image('<meta property="og:image" content="/media/Fig1.png">', page) == "https://link.example.org/media/Fig1.png"
    assert pf.preview_image('<meta content="https://x.org/a.png" name="twitter:image">', page) == "https://x.org/a.png"
    assert pf.preview_image('<meta property="og:image" content="https://x.org/static/journal-cover.jpg">', page) is None
    assert pf.preview_image("<html></html>", page) is None


def test_answers_are_cached_and_a_none_is_retried_after_a_week(tmp_path, monkeypatch):
    monkeypatch.setattr(pf, "CACHE", tmp_path / "figures.json")
    monkeypatch.setattr(pf, "_cache", None)
    calls = []
    monkeypatch.setattr(pf, "_find", lambda doi, arxiv, url: (calls.append(doi), (None, True))[1])
    assert pf.figure("10.1/x", now=0) is None
    assert pf.figure("10.1/x", now=3600) is None
    assert calls == ["10.1/x"]
    assert pf.figure("10.1/x", now=pf.RETRY_NONE_S + 1) is None
    assert calls == ["10.1/x", "10.1/x"]


def test_a_none_from_an_error_is_retried_after_an_hour(tmp_path, monkeypatch):
    monkeypatch.setattr(pf, "CACHE", tmp_path / "figures.json")
    monkeypatch.setattr(pf, "_cache", None)
    calls = []
    monkeypatch.setattr(pf, "_find", lambda doi, arxiv, url: (calls.append(doi), (None, False))[1])
    pf.figure("10.1/y", now=0)
    pf.figure("10.1/y", now=600)
    assert calls == ["10.1/y"]
    pf.figure("10.1/y", now=pf.RETRY_ERROR_S + 1)
    assert calls == ["10.1/y", "10.1/y"]


def test_a_blocked_journal_paper_gets_its_preprint_figure(monkeypatch):
    def get(url, limit=600_000):
        if url.startswith("https://api.openalex.org/works/doi:10.1021/acsnano.6c11666"):
            return 200, url, b'{"locations":[{"landing_page_url":"https://arxiv.org/abs/2301.06171"}]}'
        if url == "https://arxiv.org/html/2301.06171":
            return 200, "https://arxiv.org/html/2301.06171v2/", b'<img src="x1.png" class="ltx_graphics ltx_img_landscape">'
        if "doi.org" in url:
            return 403, url, b"challenge"
        raise AssertionError(url)
    monkeypatch.setattr(pf, "_get", get)
    assert pf._find("10.1021/acsnano.6c11666", None, None) == ("https://arxiv.org/html/2301.06171v2/x1.png", True)


def test_a_timeout_makes_the_none_unsettled(monkeypatch):
    def get(url, limit=600_000):
        raise TimeoutError("timed out")
    monkeypatch.setattr(pf, "_get", get)
    assert pf._find("10.1021/acs.jpcc.6c01336", None, None) == (None, False)


def test_a_publisher_refusal_is_a_settled_none(monkeypatch):
    import urllib.error
    def get(url, limit=600_000):
        if "openalex" in url:
            return 200, url, b'{"locations":[]}'
        raise urllib.error.HTTPError(url, 403, "Forbidden", {}, None)
    monkeypatch.setattr(pf, "_get", get)
    assert pf._find("10.1021/acs.jpcc.6c01336", None, None) == (None, True)
