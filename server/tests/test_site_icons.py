"""site_icons: a site's own icon, fetched once and kept; only public https sites (spec 021 follow-up)."""
from __future__ import annotations

import json

import pytest

import kb
import site_icons


@pytest.fixture()
def fake(tmp_path, monkeypatch):
    monkeypatch.setattr(kb, "HOME", tmp_path)
    monkeypatch.setattr(site_icons, "public_host", lambda host: None)
    calls = []
    pages = {
        "https://chemrxiv.org/": (b'<html><head><link rel="icon" href="/fav.png"><link rel="apple-touch-icon" href="/touch.png"></head></html>', "text/html"),
        "https://chemrxiv.org/touch.png": (b"\x89PNGtouch", "image/png"),
        "https://chemrxiv.org/fav.png": (b"\x89PNGfav", "image/png"),
        "https://api.openalex.org/sources/S12?select=homepage_url": (json.dumps({"homepage_url": "https://www.nature.com/npjcompumats/"}).encode(), "application/json"),
        "https://nature.com/": (b"<html></html>", "text/html"),
        "https://nature.com/favicon.ico": (b"\x00\x00ico", "image/x-icon"),
    }

    def get(url, limit):
        calls.append(url)
        if url not in pages:
            raise OSError("404")
        return pages[url]
    return get, calls


def test_the_apple_touch_icon_wins_and_is_kept(fake):
    get, calls = fake
    path, kind = site_icons.site_icon(domain="chemrxiv.org", get=get)
    assert kind == "image/png" and path.read_bytes() == b"\x89PNGtouch"
    n = len(calls)
    assert site_icons.site_icon(domain="chemrxiv.org", get=get)[0] == path
    assert len(calls) == n, "the second time comes from the kept file"


def test_a_journal_by_its_openalex_id_falls_back_to_favicon(fake):
    get, calls = fake
    path, kind = site_icons.site_icon(openalex="S12", get=get)
    assert kind == "image/x-icon" and path.read_bytes() == b"\x00\x00ico"


def test_a_site_with_no_icon_is_remembered(fake):
    get, calls = fake
    assert site_icons.site_icon(domain="nothing.example", get=get) is None
    n = len(calls)
    assert site_icons.site_icon(domain="nothing.example", get=get) is None and len(calls) == n


def test_private_and_odd_hosts_are_refused():
    for host in ("localhost", "127.0.0.1", "not a host", "intranet"):
        with pytest.raises(site_icons.Refused):
            site_icons.public_host(host)
    with pytest.raises(site_icons.Refused):
        site_icons.domain_of_openalex("../../etc")


def test_bot_protected_sites_fall_back_to_the_icon_service(fake):
    get, calls = fake
    def guarded(url, limit):
        calls.append(url)
        if url == "https://icons.duckduckgo.com/ip3/europepmc.org.ico":
            return b"\x00\x00ico", "image/x-icon"
        raise OSError("HTTP 403")
    path, kind = site_icons.site_icon(domain="europepmc.org", get=guarded)
    assert kind == "image/x-icon" and calls[-1].startswith("https://icons.duckduckgo.com/")


def test_an_unknown_journal_is_no_icon_not_an_error(fake):
    def missing(url, limit):
        raise OSError("HTTP 404")
    assert site_icons.site_icon(openalex="S999", get=missing) is None
    calls = []
    def back(url, limit):
        calls.append(url)
        raise OSError("HTTP 429")
    site_icons.site_icon(openalex="S999", get=back)
    assert calls, "a failed OpenAlex lookup is not remembered as a miss: the next call asks again"
