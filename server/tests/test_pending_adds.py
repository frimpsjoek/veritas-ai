"""Add to Zotero and Read later from the web app (spec 013 W3)."""
from __future__ import annotations

import http.client
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

import http_api
import pending_adds
import web_app

PAPER = {"title": "Quantum Hall effect in twisted bilayers", "authors": ["Ada Lovelace", "Alan M. Turing"], "year": 2023,
         "venue": "Phys. Rev. B", "doi": "https://doi.org/10.1103/PhysRevB.108.235156", "abstract": "We show.",
         "url": None, "source": "openalex"}


class FakeZotero(BaseHTTPRequestHandler):
    """The ping and the Second Brain plugin's apply endpoint. `mode` is ok, missing (older plugin) or slow."""
    calls: list = []
    mode = "ok"

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"ok")

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.calls.append((self.path, body))
        if self.mode == "missing":
            return self._reply(404, {})
        if self.mode == "slow":
            time.sleep(1.5)
        self._reply(200, {"results": [{"id": i, "ok": True, "key": "KEY" + i[:4]} for i in body["ids"]]})

    def _reply(self, status, payload):
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(web_app, "WEB_DIR", tmp_path / "web")
    monkeypatch.setattr(pending_adds, "ZOTERO_URL", "http://127.0.0.1:1")  # nothing listens: Zotero is closed
    FakeZotero.calls, FakeZotero.mode = [], "ok"
    fake = ThreadingHTTPServer(("127.0.0.1", 0), FakeZotero)
    threading.Thread(target=fake.serve_forever, daemon=True).start()

    def zotero_up(mode="ok"):
        FakeZotero.mode = mode
        monkeypatch.setattr(pending_adds, "ZOTERO_URL", f"http://127.0.0.1:{fake.server_port}")
    yield zotero_up
    fake.shutdown()
    fake.server_close()


def test_zotero_running_applies_the_queued_entry_and_reports_its_key(env):
    env()
    [result] = pending_adds.add_papers([PAPER], "COLL0001", "Read later")
    assert result["status"] == "added" and result["key"] == "KEY" + result["id"][:4]
    [(path, body)] = FakeZotero.calls
    assert path == "/second-brain/pending-adds/apply" and body == {"ids": [result["id"]]}
    queued = json.loads(pending_adds._path().read_text())[0]
    assert queued["collection"] == "COLL0001" and queued["tag"] == "Read later" and queued["paper"]["title"] == PAPER["title"]


def test_an_older_plugin_without_the_endpoint_leaves_the_entry_queued(env):
    env("missing")
    [result] = pending_adds.add_papers([PAPER])
    assert result["status"] == "queued" and [e["id"] for e in pending_adds.pending()] == [result["id"]]


def test_a_slow_plugin_times_out_and_the_entry_stays_queued(env, monkeypatch):
    env("slow")
    monkeypatch.setattr(pending_adds, "APPLY_TIMEOUT", 0.3)
    [result] = pending_adds.add_papers([PAPER])
    assert result["status"] == "queued" and len(pending_adds.pending()) == 1


def test_a_plugin_that_could_not_apply_an_entry_leaves_it_queued(env, monkeypatch):
    env()
    monkeypatch.setattr(pending_adds, "apply_now", lambda ids: {ids[0]: {"id": ids[0], "ok": False, "message": "boom"}})
    assert pending_adds.add_papers([PAPER])[0]["status"] == "queued"


def test_connector_down_queues_and_dedupes_by_doi_and_title(env):
    first = pending_adds.add_papers([PAPER], "COLL0001")
    again = pending_adds.add_papers([{**PAPER, "doi": "10.1103/PhysRevB.108.235156"}, {"title": "quantum HALL effect in twisted bilayers"}], "COLL0001")
    assert first[0]["status"] == again[0]["status"] == again[1]["status"] == "queued"
    assert first[0]["id"] == again[0]["id"] == again[1]["id"]
    [entry] = pending_adds.pending()
    assert entry["kind"] == "add" and entry["collection"] == "COLL0001" and entry["paper"]["title"] == PAPER["title"] and not entry["done"]


def test_a_paper_without_a_title_fails(env):
    assert pending_adds.add_papers([{"doi": "10.1/x"}, "nope"]) == [{"status": "failed", "message": "a paper needs a title"}] * 2


def test_done_drops_entries_and_attempts_give_up_after_five(env):
    [a] = pending_adds.add_papers([PAPER])
    [b] = pending_adds.add_papers([{"title": "Another"}])
    pending_adds.done([a["id"]])
    assert [e["id"] for e in pending_adds.pending()] == [b["id"]]
    for _ in range(4):
        pending_adds.attempt(b["id"], "boom")
    assert pending_adds.pending()[0]["attempts"] == 4
    pending_adds.attempt(b["id"], "boom")
    assert pending_adds.pending() == []
    assert json.loads(pending_adds._path().read_text())[0]["failed"] is True


def test_read_later_queues_a_tag_edit_once(env):
    one = pending_adds.tag_item("ABCD1234", None, None, "Read later")
    two = pending_adds.tag_item("ABCD1234", None, None, "Read later")
    assert one == two and one["status"] == "queued"
    [entry] = pending_adds.pending()
    assert entry["kind"] == "tag" and entry["key"] == "ABCD1234" and entry["tag"] == "Read later"
    with pytest.raises(ValueError):
        pending_adds.tag_item(None, None, None, "Read later")


def test_the_queue_is_written_atomically(env, monkeypatch):
    pending_adds.add_papers([PAPER])
    before = pending_adds._path().read_text()
    monkeypatch.setattr(json, "dump", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("disk full")))
    with pytest.raises(RuntimeError):
        pending_adds.add_papers([{"title": "Second"}])
    assert pending_adds._path().read_text() == before
    assert [p.name for p in web_app.WEB_DIR.iterdir()] == ["pending-adds.json"]


@pytest.fixture
def api(env):
    server = ThreadingHTTPServer(("127.0.0.1", 0), http_api.Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    def call(method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
        conn.request(method, path, json.dumps(body) if body is not None else None, headers or {})
        res = conn.getresponse()
        raw = res.read()
        conn.close()
        return res.status, json.loads(raw) if raw else None
    yield call
    server.shutdown()
    server.server_close()


def test_routes_queue_list_and_finish_an_add(api):
    status, body = api("POST", "/zotero/add", {"papers": [PAPER], "collection": "COLL0001", "tag": "Read later"})
    assert status == 200 and body["results"][0]["status"] == "queued"
    status, listed = api("GET", "/zotero/pending-adds")
    assert [e["id"] for e in listed] == [body["results"][0]["id"]] and listed[0]["tag"] == "Read later"
    assert api("POST", "/zotero/pending-adds/attempt", {"id": listed[0]["id"], "message": "x"})[1] == {"ok": True}
    api("POST", "/zotero/pending-adds/done", {"ids": [listed[0]["id"]]})
    assert api("GET", "/zotero/pending-adds")[1] == []


def test_routes_validate_and_tag(api):
    assert api("POST", "/zotero/add", {"papers": "x"})[0] == 400
    assert api("POST", "/zotero/tag", {"tag": "Read later"})[0] == 400
    status, body = api("POST", "/zotero/tag", {"doi": "10.1/x", "tag": "Read later"})
    assert status == 200 and body["status"] == "queued"


def test_a_website_and_an_agent_are_refused(api):
    assert api("POST", "/zotero/add", {"papers": [PAPER]}, {"Sec-Fetch-Site": "cross-site"})[0] == 403
    assert api("GET", "/zotero/pending-adds", None, {"Sec-Fetch-Site": "cross-site"})[0] == 403
    assert "/zotero/add" not in http_api.AGENT_ROUTES and "/zotero/tag" not in http_api.AGENT_ROUTES


def test_the_queue_file_is_not_served_as_a_static_file(api):
    api("POST", "/zotero/add", {"papers": [PAPER]})
    assert api("GET", "/app/pending-adds.json")[0] == 404


HIGHLIGHT = {"type": "highlight", "text": " Voles cache seeds in autumn. ", "comment": "check", "color": "#FFD400",
             "position": {"pageIndex": 2, "rects": [[72, 700.12345, 300.5, 712], [72, 686, 140, 698]]},
             "sortIndex": "00002|000123|00079", "pageLabel": "3"}


def test_a_highlight_is_queued_for_the_attachment_with_a_stable_zotero_key(env):
    result = pending_adds.annotate("ABCD2345", HIGHLIGHT)
    assert result == {"status": "queued", "id": result["id"]}
    [entry] = pending_adds.pending()
    assert entry["kind"] == "annotation" and entry["key"] == "ABCD2345"
    assert entry["annotation"] == {
        "type": "highlight", "text": "Voles cache seeds in autumn.", "comment": "check", "color": "#ffd400", "pageLabel": "3",
        "sortIndex": "00002|000123|00079", "position": {"pageIndex": 2, "rects": [[72.0, 700.123, 300.5, 712.0], [72.0, 686.0, 140.0, 698.0]]},
        "key": pending_adds.annotation_key(entry["id"])}
    assert pending_adds.ZOTERO_KEY.match(entry["annotation"]["key"])
    assert pending_adds.annotation_key(entry["id"]) == pending_adds.annotation_key(entry["id"])


def test_the_same_highlight_twice_is_queued_once_and_two_highlights_twice(env):
    one = pending_adds.annotate("ABCD2345", HIGHLIGHT)
    assert pending_adds.annotate("ABCD2345", HIGHLIGHT)["id"] == one["id"]
    other = pending_adds.annotate("ABCD2345", {**HIGHLIGHT, "color": "#5fb236"})
    assert other["id"] != one["id"] and len(pending_adds.pending()) == 2
    entries = pending_adds.pending()
    assert entries[0]["annotation"]["key"] != entries[1]["annotation"]["key"]


def test_a_running_zotero_applies_the_highlight_at_once(env):
    env()
    result = pending_adds.annotate("ABCD2345", HIGHLIGHT)
    assert result["status"] == "added" and FakeZotero.calls == [("/second-brain/pending-adds/apply", {"ids": [result["id"]]})]


@pytest.mark.parametrize("key, change", [
    ("abcd2345", {}), ("ABCD0123", {}), (None, {}),
    ("ABCD2345", {"type": "ink"}), ("ABCD2345", {"text": "  "}), ("ABCD2345", {"text": "x" * 10_001}),
    ("ABCD2345", {"comment": 5}), ("ABCD2345", {"color": "#123456"}), ("ABCD2345", {"position": None}),
    ("ABCD2345", {"position": {"pageIndex": -1, "rects": [[0, 0, 1, 1]]}}),
    ("ABCD2345", {"position": {"pageIndex": 2, "rects": []}}),
    ("ABCD2345", {"position": {"pageIndex": 2, "rects": [[0, 0, 1]]}}),
    ("ABCD2345", {"position": {"pageIndex": 2, "rects": [[0, 0, 1, float("nan")]]}}),
    ("ABCD2345", {"position": {"pageIndex": 2, "rects": [[5, 0, 1, 1]]}}),
    ("ABCD2345", {"position": {"pageIndex": 2, "rects": [[0, 0, 1, 1]] * 501}}),
    ("ABCD2345", {"sortIndex": "2|123|79"}), ("ABCD2345", {"sortIndex": "00003|000123|00079"}),
])
def test_a_malformed_highlight_is_refused_and_nothing_is_queued(env, key, change):
    with pytest.raises(ValueError):
        pending_adds.annotate(key, {**HIGHLIGHT, **change})
    assert pending_adds.pending() == []


def test_the_annotate_route_queues_and_refuses(api):
    status, body = api("POST", "/zotero/annotate", {"key": "ABCD2345", "annotation": HIGHLIGHT})
    assert status == 200 and body["status"] == "queued"
    [listed] = api("GET", "/zotero/pending-adds")[1]
    assert listed["id"] == body["id"] and listed["annotation"]["text"] == "Voles cache seeds in autumn."
    status, body = api("POST", "/zotero/annotate", {"key": "ABCD2345", "annotation": {**HIGHLIGHT, "color": "red"}})
    assert status == 400 and "colour" in body["error"]
    assert api("POST", "/zotero/annotate", {"key": "ABCD2345", "annotation": HIGHLIGHT}, {"Sec-Fetch-Site": "cross-site"})[0] == 403
    assert "/zotero/annotate" not in http_api.AGENT_ROUTES
