"""Tenant forwarding, private web state, and sidecar-only ALCF credential delivery."""
from __future__ import annotations

import http.client
import json
import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

import pytest

import agent_api
import globus_auth
import http_api
import web_app
import sources
import zotero

TENANT_A = "a" * 64
TENANT_B = "b" * 64
PHONE = {"Host": "veritas.trinityscience.org", "X-Forwarded-Proto": "https"}
SESSION_A = "session-A"
SESSION_B = "session-B"
SIDECAR_SECRET = "sidecar-secret"


class TenantGlobus:
    def __init__(self, root: Path):
        self.config = globus_auth.Config("client-A", "secret-A", globus_auth.PRODUCTION_CALLBACK)
        self.store = SimpleNamespace(root=root)
        self.calls = []
        self.tokens = {TENANT_A: "access-A", TENANT_B: "access-B"}

    def principal(self, raw):
        tenant = {SESSION_A: TENANT_A, SESSION_B: TENANT_B}.get(raw)
        if not tenant:
            return None
        return {"kind": "globus", "tenant": tenant, "name": "User", "preferred_username": "u@alcf.anl.gov"}

    def inference_credential(self, tenant, force=False):
        self.calls.append((tenant, force))
        if tenant not in self.tokens:
            raise globus_auth.AuthError(401, "ALCF Inference sign-in is required")
        return {"access_token": self.tokens[tenant], "expires_at": 1234}

    def inference_status(self, tenant):
        return {"connected": True, "needs_reauth": False, "expires_at": 1234}

    def logout(self, raw):
        raise AssertionError("not used")


class SidecarEcho(BaseHTTPRequestHandler):
    def _echo(self):
        body = json.dumps({
            "method": self.command,
            "path": self.path,
            "tenant": self.headers.get("X-Veritas-Tenant"),
        }).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    do_GET = _echo
    do_POST = _echo

    def log_message(self, *args):
        pass


@pytest.fixture
def tenant_server(tmp_path, monkeypatch):
    monkeypatch.setattr(http_api, "TOKEN_FILE", tmp_path / "api-token")
    monkeypatch.setattr(http_api, "SESSIONS_FILE", tmp_path / "legacy-sessions.json")
    monkeypatch.setattr(web_app, "WEB_DIR", tmp_path / "shared-web")
    (tmp_path / "api-token").write_text("admin-token")
    manager = TenantGlobus(tmp_path / "users")
    for tenant in (TENANT_A, TENANT_B):
        (tmp_path / "users" / tenant).mkdir(parents=True, mode=0o700)
    echo = ThreadingHTTPServer(("127.0.0.1", 0), SidecarEcho)
    threading.Thread(target=echo.serve_forever, daemon=True).start()
    sidecar = agent_api.Sidecar(node=Path("node"), secret=SIDECAR_SECRET, port=echo.server_address[1])
    monkeypatch.setattr(http_api, "AGENT_SIDECAR", sidecar)
    monkeypatch.setattr(http_api, "GLOBUS_AUTH", manager)
    srv = ThreadingHTTPServer(("127.0.0.1", 0), http_api.Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield srv.server_address[1], manager, sidecar, tmp_path
    srv.shutdown()
    srv.server_close()
    echo.shutdown()
    echo.server_close()


def call(port, method, path, headers=None, body=None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    payload = json.dumps(body).encode() if body is not None else None
    conn.request(method, path, body=payload, headers={**PHONE, **(headers or {})})
    response = conn.getresponse()
    status, all_headers, data = response.status, response.getheaders(), response.read()
    conn.close()
    return status, all_headers, data


def value(headers, name):
    values = [v for k, v in headers if k.lower() == name.lower()]
    return values[0] if values else None


def cookie(session, spoof=None):
    return {"Cookie": f"vg_session={session}", **({"X-Veritas-Tenant": spoof} if spoof else {})}


def tenant_agent(tenant=TENANT_A):
    """The capability the tenant sidecar must present to the shared Python library API."""
    return {"Authorization": f"Bearer {SIDECAR_SECRET}", "X-Veritas-Tenant": tenant,
            "X-KB-Client": "agent"}


def operator_agent():
    return {"Authorization": "Bearer admin-token", "X-KB-Client": "agent"}


def json_call(*args, **kwargs):
    status, headers, body = call(*args, **kwargs)
    return status, headers, json.loads(body)


def test_verified_cookie_selects_tenant_and_external_spoof_is_ignored(tenant_server):
    port, _, _, _ = tenant_server
    status, _, body = json_call(port, "GET", "/agent/conversations", cookie(SESSION_A, TENANT_B))
    assert status == 200 and body == {"method": "GET", "path": "/conversations", "tenant": TENANT_A}

    status, _, body = json_call(port, "GET", "/agent/conversations", cookie(SESSION_B))
    assert status == 200 and body["tenant"] == TENANT_B

    status, _, body = json_call(port, "GET", "/agent/conversations", {"X-Veritas-Tenant": TENANT_A})
    assert status == 401  # anonymous input never selects a runtime

    status, _, body = json_call(port, "GET", "/agent/conversations", {
        "Authorization": "Bearer admin-token", "X-Veritas-Tenant": TENANT_B,
    })
    assert status == 200 and body["tenant"] is None


def test_globus_interactive_routes_and_background_denials(tenant_server):
    port, _, _, _ = tenant_server
    for path in ("/agent/conversations", "/agent/providers", "/agent/settings", "/agent/projects", "/agent/skills"):
        assert call(port, "GET", path, cookie(SESSION_A))[0] == 200, path
    for method, path in (("POST", "/agent/reviews"), ("GET", "/agent/reviews"),
                         ("POST", "/agent/routines"), ("GET", "/agent/routines")):
        assert call(port, method, path, cookie(SESSION_A), {})[0] == 403, (method, path)
    assert not http_api.globus_route_allowed("GET", "/auth/globus/agent-token")
    assert "/auth/globus/agent-token" not in json.dumps(http_api.a2a_api.agent_card())


def test_tenant_cannot_configure_host_execution_or_custom_endpoints(tenant_server):
    port, _, _, _ = tenant_server
    attacks = [
        ("/agent/mcp-servers", {"name": "evil", "transport": "stdio", "command": "/bin/sh", "args": ["-c", "id"]}),
        ("/agent/mcp-servers", {"name": "evil", "transport": "http", "url": "http://127.0.0.1:27182"}),
    ]
    for path, body in attacks:
        status, _, _ = call(port, "POST", path, cookie(SESSION_A), body)
        assert status == 403, (path, body)


def test_identity_is_resolved_once_and_never_falls_back_to_legacy(tenant_server, monkeypatch):
    port, _, _, _ = tenant_server
    original = http_api.principal
    calls = 0
    def revoke(headers):
        nonlocal calls
        calls += 1
        first = original(headers)
        return first if calls == 1 else None
    monkeypatch.setattr(http_api, "principal", revoke)
    status, _, body = json_call(port, "GET", "/agent/conversations", cookie(SESSION_A))
    assert status == 200 and body["tenant"] == TENANT_A
    calls = 0
    assert call(port, "GET", "/web/state", cookie(SESSION_A))[0] == 200


def test_tenant_responses_are_not_storable(tenant_server, monkeypatch):
    port, _, _, root = tenant_server
    status, headers, _ = call(port, "GET", "/agent/conversations", cookie(SESSION_A))
    assert status == 200 and value(headers, "Cache-Control") == "no-store"
    status, headers, _ = call(port, "GET", "/web/state", cookie(SESSION_A))
    assert status == 200 and value(headers, "Cache-Control") == "no-store"

    image = root / "image.png"
    image.write_bytes(b"image-data")
    monkeypatch.setattr(http_api.paper_notes, "image_file", lambda *args: image)
    monkeypatch.setattr(http_api.kb, "index_path", lambda path: "image.png")
    monkeypatch.setattr(http_api.kb, "note_path", lambda path: path)
    status, headers, _ = call(port, "GET", "/file?name=image.png", cookie(SESSION_A))
    assert status == 200 and value(headers, "Cache-Control") == "private, no-store"
    status, headers, _ = call(port, "GET", "/file?name=image.png", {"Authorization": "Bearer admin-token"})
    assert status == 200 and value(headers, "Cache-Control") == "private, max-age=300"

    monkeypatch.setattr(http_api.site_icons, "site_icon", lambda **kwargs: (image, "image/png"))
    status, headers, _ = call(port, "GET", "/site-icon?domain=example.org", cookie(SESSION_A))
    assert status == 200 and value(headers, "Cache-Control") == "private, no-store"
    status, headers, _ = call(port, "GET", "/site-icon?domain=example.org", {"Authorization": "Bearer admin-token"})
    assert status == 200 and value(headers, "Cache-Control") == "private, max-age=86400"


def test_globus_library_reads_enforce_privacy_rules(tenant_server, monkeypatch):
    port, _, _, _ = tenant_server
    monkeypatch.setattr(http_api.kb, "privacy", lambda: {"agent_read_max_chars": 5})
    monkeypatch.setattr(http_api.kb, "private_paths", lambda: {"private.md"})
    monkeypatch.setattr(http_api.kb, "note_path", lambda path: path)
    monkeypatch.setattr(http_api.kb, "read_note", lambda path, heading, max_chars, offset: {
        "path": path, "max_chars": max_chars, "text": "public-content",
    })

    assert call(port, "GET", "/note?path=private.md", cookie(SESSION_A))[0] == 403
    status, _, body = json_call(port, "GET", "/note?path=public.md&max_chars=100", cookie(SESSION_A))
    assert status == 200 and body["max_chars"] == 5

    status, _, body = json_call(port, "GET", "/note?path=private.md&max_chars=100", {
        "Authorization": "Bearer admin-token",
    })
    assert status == 200 and body["max_chars"] == 100


def test_globus_link_panel_keeps_private_address_refusals(tenant_server):
    port, _, _, _ = tenant_server
    status, _, body = json_call(port, "GET", "/web/page?url=http%3A%2F%2F127.0.0.1%3A1%2Fstatus", cookie(SESSION_A))
    assert status == 200 and body["mode"] == "blocked"
    assert call(port, "GET", "/web/pdf?url=http%3A%2F%2Flocalhost%2Fx.pdf", cookie(SESSION_A))[0] == 400


@pytest.mark.parametrize("route", [
    "/folder-file?path=papers:/private.pdf",
    "/file?name=private.png",
    "/paper-note?key=PRIVATE1",
    "/paper-note/body?key=PRIVATE1",
])
def test_globus_file_and_paper_note_routes_enforce_private_paths(tenant_server, monkeypatch, route):
    port, _, _, root = tenant_server
    monkeypatch.setattr(http_api.kb, "private_paths", lambda: {
        "zotero/PRIVATE1", "papers:/private.pdf", "private.png",
    })
    monkeypatch.setattr(http_api.kb, "note_path", lambda path: path)
    monkeypatch.setattr(http_api.zotero, "ZOTERO", root)
    pdf = root / "private.pdf"
    image = root / "private.png"
    pdf.write_bytes(b"private-pdf")
    image.write_bytes(b"private-image")
    monkeypatch.setattr(http_api.kb, "document_file", lambda path: pdf)
    monkeypatch.setattr(http_api.kb, "index_path", lambda path: {
        pdf: "papers:/private.pdf", image: "private.png",
    }[path])
    monkeypatch.setattr(http_api.paper_notes, "image_file", lambda *args: image)
    reached = []

    def serve_pdf(handler, key):
        reached.append(("zotero-pdf", key))
        handler._send(200, {"reached": True})

    def stream_file(handler, path, kind):
        reached.append(("folder-file", str(path)))
        handler._send(200, {"reached": True})

    monkeypatch.setattr(http_api.pdf_route, "serve", serve_pdf)
    monkeypatch.setattr(http_api.pdf_route, "stream", stream_file)
    monkeypatch.setattr(http_api.paper_notes, "summary", lambda key: reached.append(("summary", key)) or {})
    monkeypatch.setattr(http_api.paper_notes, "body", lambda key: reached.append(("body", key)) or {})

    assert call(port, "GET", route, cookie(SESSION_A))[0] == 403
    assert reached == []


@pytest.fixture
def library_server(tenant_server, monkeypatch):
    """Real index paths and Zotero parent rows, never the operator's library."""
    port, _, _, root = tenant_server
    main, lab = root / "Zotero", root / "Lab"
    for library in (main, lab):
        library.mkdir()
        db = sqlite3.connect(library / "zotero.sqlite")
        db.executescript("""
            CREATE TABLE items(itemID INTEGER PRIMARY KEY, key TEXT, libraryID INTEGER);
            CREATE TABLE itemAttachments(itemID INTEGER, parentItemID INTEGER, contentType TEXT, linkMode INTEGER, path TEXT);
            CREATE TABLE deletedItems(itemID INTEGER);
            CREATE TABLE fields(fieldID INTEGER PRIMARY KEY, fieldName TEXT);
            CREATE TABLE itemData(itemID INTEGER, fieldID INTEGER, valueID INTEGER);
            CREATE TABLE itemDataValues(valueID INTEGER PRIMARY KEY, value TEXT);
            INSERT INTO items VALUES (1, 'PARENT01', 1), (2, 'ATTACH01', 1),
                                     (3, 'PUBLIC01', 1), (4, 'PUBATT01', 1),
                                     (5, 'ORPHAN01', 1), (6, 'UNINDEX1', 1), (7, 'UNATT001', 1);
            INSERT INTO itemAttachments VALUES (2, 1, 'application/pdf', 0, 'storage:paper.pdf'),
                                               (4, 3, 'application/pdf', 0, 'storage:paper.pdf'),
                                               (5, NULL, 'application/pdf', 0, 'storage:paper.pdf'),
                                               (7, 6, 'application/pdf', 0, 'storage:paper.pdf');
            INSERT INTO fields VALUES (1, 'DOI'), (2, 'title');
            INSERT INTO itemDataValues VALUES (1, '10.1234/private'), (2, 'Private title'),
                                             (3, '10.1234/public'), (4, 'Public title');
            INSERT INTO itemData VALUES (1, 1, 1), (1, 2, 2), (3, 1, 3), (3, 2, 4);
        """)
        db.close()
        for key in ("ATTACH01", "PUBATT01", "ORPHAN01", "MISSING1", "UNATT001"):
            folder = library / "storage" / key
            folder.mkdir(parents=True)
            (folder / "paper.pdf").write_bytes(b"%PDF-1.7 fixture " + key.encode())
    monkeypatch.setattr(zotero, "ZOTERO", main)
    monkeypatch.setattr(zotero, "snapshot", lambda *a, **k: sqlite3.connect(
        f"file:{zotero.root() / 'zotero.sqlite'}?mode=ro", uri=True))
    monkeypatch.setattr(http_api.kb, "LAYOUT", sources.Layout(
        root / "vault", False, main, [], [], [],
        [sources.Folder("main", main, detected="zotero"), sources.Folder("lab", lab, detected="zotero")]))
    monkeypatch.setattr(http_api.kb, "VAULT", root / "vault")
    (root / "vault").mkdir()
    monkeypatch.setattr(http_api.kb, "DB_PATH", root / "index.sqlite")
    monkeypatch.setattr(http_api.kb, "PRIVACY_FILE", root / "privacy.json")
    monkeypatch.setattr(http_api.kb, "_private_cache", {})
    monkeypatch.setattr(http_api, "_zotero_status", {"at": 0.0})
    db = http_api.kb.connect()
    for prefix in ("", "lab:/"):
        for key, tags in (("PARENT01", "private"), ("PUBLIC01", "")):
            path = prefix + "zotero/" + key
            db.execute("INSERT INTO notes(path,source,tags) VALUES (?, 'zotero', ?)", (path, tags))
            db.execute("INSERT INTO chunks(path,heading) VALUES (?, 'Full text')", (path,))
    # A legitimate parent in the default library collides with a named-library attachment.
    db.execute("INSERT INTO notes(path,source) VALUES ('zotero/ATTACH01', 'zotero')")
    db.commit()
    db.close()
    monkeypatch.setattr(http_api.site_icons, "public_host", lambda host: None)
    monkeypatch.setattr(http_api.web_page, "openalex", lambda *a, **k: pytest.fail("unexpected network fallback"))
    return port, root, main, lab


@pytest.mark.parametrize("library", ["", "&library=main", "&library=lab"])
def test_pdf_checks_selected_library_parent_before_resolving(library_server, monkeypatch, library):
    port, _, _, _ = library_server
    monkeypatch.setattr(http_api.pdf_route, "resolve", lambda *a: pytest.fail("private PDF was accessed"))
    assert call(port, "GET", f"/zotero/pdf?key=ATTACH01{library}", cookie(SESSION_A))[0] == 403


@pytest.mark.parametrize("library", ["", "&library=main", "&library=lab"])
@pytest.mark.parametrize("admin", [False, True])
def test_operator_pdf_and_range_are_admin_only(library_server, library, admin):
    port, _, _, _ = library_server
    auth = {"Authorization": "Bearer admin-token"} if admin else cookie(SESSION_A)
    path = f"/zotero/pdf?key=PUBATT01{library}"
    status, _, body = call(port, "GET", path, auth)
    status_range, headers, range_body = call(port, "GET", path, {**auth, "Range": "bytes=0-4"})
    if not admin:
        assert status == status_range == 403
        assert b"fixture" not in body and b"fixture" not in range_body
        return
    assert status == 200 and body == b"%PDF-1.7 fixture PUBATT01"
    assert status_range == 206 and range_body == b"%PDF-"
    assert value(headers, "Content-Range") == "bytes 0-4/25"


@pytest.mark.parametrize("key", ["ORPHAN01", "MISSING1", "UNATT001"])
def test_unknown_pdf_owner_denied_with_empty_hidden_set_but_admin_keeps_fallback(library_server, monkeypatch, key):
    port, _, _, _ = library_server
    monkeypatch.setattr(http_api.kb, "private_paths", lambda: set())
    real = http_api.pdf_route.resolve
    with monkeypatch.context() as patch:
        patch.setattr(http_api.pdf_route, "resolve", lambda *a: pytest.fail("unknown-owner file accessed"))
        assert call(port, "GET", f"/zotero/pdf?key={key}", cookie(SESSION_A))[0] in (403, 404)
    assert http_api.pdf_route.resolve is real
    assert call(port, "GET", f"/zotero/pdf?key={key}", {"Authorization": "Bearer admin-token"})[0] == 200


@pytest.mark.parametrize("error", [sqlite3.OperationalError, OSError, RuntimeError])
def test_unreadable_ownership_db_fails_closed(library_server, monkeypatch, error):
    port, _, _, _ = library_server
    monkeypatch.setattr(http_api.kb, "private_paths", lambda: set())
    def fail(*a, **k):
        raise error("synthetic private database path")
    monkeypatch.setattr(zotero, "snapshot", fail)
    monkeypatch.setattr(http_api.pdf_route, "resolve", lambda *a: pytest.fail("file accessed after lookup failure"))
    for path in ("/zotero/pdf?key=PUBATT01", "/web/pdf?url=https://doi.org/10.1234/public",
                 "/web/page?url=https://doi.org/10.1234/public"):
        status, _, body = call(port, "GET", path, cookie(SESSION_A))
        assert status == 403 and b"synthetic" not in body


@pytest.mark.parametrize("route", ["/web/page", "/web/pdf"])
def test_doi_private_copy_denied_before_file_resolution(library_server, monkeypatch, route):
    port, _, _, _ = library_server
    statements = []
    snapshot = zotero.snapshot
    def traced_snapshot(*args, **kwargs):
        db = snapshot(*args, **kwargs)
        db.set_trace_callback(statements.append)
        return db
    monkeypatch.setattr(zotero, "snapshot", traced_snapshot)
    monkeypatch.setattr(http_api.pdf_route, "resolve", lambda *a: pytest.fail("private local copy accessed"))
    status, _, body = call(port, "GET", route + "?url=https://doi.org/10.1234/private", cookie(SESSION_A))
    assert status == 403 and b"Private title" not in body
    assert not any("'title'" in sql for sql in statements)


@pytest.mark.parametrize("private", [False, True])
def test_linked_pdf_is_admin_only(library_server, monkeypatch, private):
    port, root, main, _ = library_server
    key, item_id = ("ATTACH01", 2) if private else ("PUBATT01", 4)
    linked = root / "linked.pdf"
    linked.write_bytes(b"%PDF-linked")
    db = sqlite3.connect(main / "zotero.sqlite")
    db.execute("UPDATE itemAttachments SET linkMode=2, path=? WHERE itemID=?", (str(linked), item_id))
    db.commit()
    db.close()
    with monkeypatch.context() as patch:
        patch.setattr(http_api.pdf_route, "_linked", lambda *a: pytest.fail("visitor linked file accessed"))
        status, _, body = call(port, "GET", f"/zotero/pdf?key={key}", cookie(SESSION_A))
        assert status == 403 and b"%PDF-linked" not in body
    status, _, body = call(port, "GET", f"/zotero/pdf?key={key}", {"Authorization": "Bearer admin-token"})
    assert status == 200 and body == b"%PDF-linked"


@pytest.mark.parametrize("admin,doi", [(False, "public"), (True, "private")])
def test_doi_library_copies_are_admin_only(library_server, admin, doi):
    port, _, _, _ = library_server
    auth = {"Authorization": "Bearer admin-token"} if admin else cookie(SESSION_A)
    query = "?url=https://doi.org/10.1234/" + doi
    status, _, result = json_call(port, "GET", "/web/page" + query, auth)
    status_pdf, _, data = call(port, "GET", "/web/pdf" + query, {**auth, "Range": "bytes=0-4"})
    if not admin:
        assert status == status_pdf == 403
        assert b"%PDF-" not in data
        return
    assert status == 200 and result["source"] == "library"
    assert status_pdf == 206 and data == b"%PDF-"


@pytest.mark.parametrize("route", ["/web/page", "/web/pdf"])
@pytest.mark.parametrize("owner", ["unindexed", "missing", "deleted"])
def test_doi_unknown_owner_fails_closed_without_private_entries(library_server, monkeypatch, route, owner):
    port, _, main, _ = library_server
    monkeypatch.setattr(http_api.kb, "private_paths", lambda: set())
    if owner == "unindexed":
        db = http_api.kb.connect()
        db.execute("DELETE FROM notes WHERE path='zotero/PUBLIC01'")
    else:
        db = sqlite3.connect(main / "zotero.sqlite")
        if owner == "missing":
            db.execute("DELETE FROM items WHERE key='PUBLIC01'")
        else:
            db.execute("INSERT INTO deletedItems VALUES (3)")
    db.commit()
    db.close()
    monkeypatch.setattr(http_api.pdf_route, "resolve", lambda *a: pytest.fail("unowned DOI file accessed"))
    assert call(port, "GET", route + "?url=https://doi.org/10.1234/public", cookie(SESSION_A))[0] in (403, 404)


@pytest.mark.parametrize("admin_first", [False, True])
def test_status_is_admin_only_without_mutating_cache(library_server, admin_first):
    port, _, _, _ = library_server
    for admin in (admin_first, not admin_first, admin_first):
        auth = {"Authorization": "Bearer admin-token"} if admin else cookie(SESSION_A)
        status, _, result = json_call(port, "GET", "/zotero/status", auth)
        if admin:
            assert status == 200 and set(result["items"]) == {"PARENT01", "PUBLIC01"}
            assert result["updated_at"] == http_api._zotero_status["at"]
        else:
            assert status == 403 and "items" not in result
        if admin or http_api._zotero_status.get("items"):
            assert set(http_api._zotero_status["items"]) == {"PARENT01", "PUBLIC01"}


def test_attachment_guards_are_request_local(library_server):
    port, _, _, _ = library_server
    requests = [
        ("/zotero/pdf?key=ATTACH01&library=lab", cookie(SESSION_A), 403),
        ("/zotero/pdf?key=PUBATT01&library=main", cookie(SESSION_B), 403),
        ("/zotero/pdf?key=ATTACH01&library=lab", {"Authorization": "Bearer admin-token"}, 200),
    ] * 4
    def request(case):
        path, auth, expected = case
        assert call(port, "GET", path, auth)[0] == expected
    with ThreadPoolExecutor(max_workers=3) as pool:
        list(pool.map(request, requests))


@pytest.mark.parametrize("route", ["/paper-note", "/paper-note/body"])
@pytest.mark.parametrize("private", [False, True])
@pytest.mark.parametrize("in_papers", [False, True])
def test_paper_notes_are_admin_only(library_server, monkeypatch, route, private, in_papers):
    port, root, _, _ = library_server
    rel = "Papers/linked.md" if in_papers else "linked.md"
    note = root / "vault" / rel
    note.parent.mkdir(exist_ok=True)
    note.write_text("---\nzotero-key: PUBLIC01\n---\n## My notes\nSecret note body\n")
    db = http_api.kb.connect()
    db.execute("INSERT INTO notes(path,source,tags,frontmatter) VALUES (?,'personal',?,?)",
               (rel, "private" if private else "", json.dumps({"zotero-key": "PUBLIC01"})))
    db.commit()
    db.close()
    with monkeypatch.context() as patch:
        if private:
            patch.setattr(http_api.paper_notes, "_read", lambda *a: pytest.fail("private note body read"))
            read_text = Path.read_text
            def checked_read(path, *args, **kwargs):
                assert path != note, "private note scanned before authorization"
                return read_text(path, *args, **kwargs)
            patch.setattr(Path, "read_text", checked_read)
        status, _, body = call(port, "GET", route + "?key=PUBLIC01", cookie(SESSION_A))
        assert status == 403 and b"Secret note body" not in body
    status, _, body = call(port, "GET", route + "?key=PUBLIC01", {"Authorization": "Bearer admin-token"})
    assert status == 200 and b"Secret note body" in body


@pytest.mark.parametrize("route", ["/paper-note", "/paper-note/body"])
def test_paper_note_denied_before_operator_library_scan(library_server, monkeypatch, route):
    port, root, _, _ = library_server
    papers = root / "vault" / "Papers"
    papers.mkdir()
    private, public = papers / "a.md", papers / "b.md"
    private.write_text("---\nzotero-key: PARENT01\n---\n## My notes\nPrivate sentinel\n")
    public.write_text("---\nzotero-key: PUBLIC01\n---\n## My notes\nRequested public content\n")
    db = http_api.kb.connect()
    db.executemany("INSERT INTO notes(path,source,tags) VALUES (?, 'personal', ?)",
                   [("Papers/a.md", "private"), ("Papers/b.md", "")])
    db.commit()
    db.close()

    enumerated, reads = [], []
    rglob, read_text = Path.rglob, Path.read_text

    def ordered_candidates(path, pattern, *args, **kwargs):
        if path == papers and pattern == "*.md":
            for candidate in (private, public):
                enumerated.append(candidate)
                yield candidate
        else:
            yield from rglob(path, pattern, *args, **kwargs)

    def checked_read(path, *args, **kwargs):
        reads.append(path)
        assert path != private, "private candidate must be skipped before reading"
        return read_text(path, *args, **kwargs)

    monkeypatch.setattr(Path, "rglob", ordered_candidates)
    monkeypatch.setattr(Path, "read_text", checked_read)
    status, _, result = json_call(port, "GET", route + "?key=PUBLIC01", cookie(SESSION_A))

    assert enumerated == [] and private not in reads and public not in reads
    assert status == 403
    assert "Requested public content" not in json.dumps(result)
    assert "Private sentinel" not in json.dumps(result)


@pytest.mark.parametrize("prefix", ["", "lab:/"])
def test_paper_note_references_are_admin_only(library_server, prefix):
    port, root, _, _ = library_server
    papers = root / "vault" / "Papers"
    papers.mkdir()
    authored = "Keep these citations: [@secretref; @publicref; @missingref; @PUBLIC01]."
    (papers / "public.md").write_text(f"---\nzotero-key: PUBLIC01\n---\n## My notes\n{authored}\n")
    db = http_api.kb.connect()
    db.execute("INSERT INTO notes(path,source,tags) VALUES ('Papers/public.md','personal','')")
    db.execute("UPDATE notes SET title=?, meta=? WHERE path=?", (
        "Private citation title", json.dumps({"citekey": "secretref", "authors": ["Private Author"],
                                             "year": "1999", "venue": "Private venue"}),
        prefix + "zotero/PARENT01"))
    db.execute("INSERT INTO notes(path,source,tags,title,meta) VALUES (?,'zotero','',?,?)", (
        prefix + "zotero/CITPUB01", "Public citation title",
        json.dumps({"citekey": "publicref", "authors": ["Public Writer"], "year": "2025", "venue": "Public venue"})))
    db.commit()
    db.close()

    public_ref = {"citekey": "publicref", "key": prefix + "zotero/CITPUB01" if prefix else "CITPUB01",
                  "title": "Public citation title", "label": "Writer 2025", "venue": "Public venue"}
    unknown_ref = {"citekey": "missingref", "key": None}
    private_ref = {"citekey": "secretref", "key": prefix + "zotero/PARENT01" if prefix else "PARENT01",
                   "title": "Private citation title", "label": "Author 1999", "venue": "Private venue"}
    for admin in (False, True):
        auth = {"Authorization": "Bearer admin-token"} if admin else cookie(SESSION_A)
        status, _, result = json_call(port, "GET", "/paper-note/body?key=PUBLIC01", auth)
        if not admin:
            assert status == 403 and "text" not in result
            continue
        assert status == 200 and result["text"] == authored
        assert result["hash"] == http_api.paper_notes._hash(authored)
        assert result["references"] == [private_ref, public_ref, unknown_ref]


def test_web_state_is_private_per_tenant(tenant_server):
    port, _, _, _ = tenant_server
    assert call(port, "POST", "/web/state", cookie(SESSION_A), {"files": {"private.txt": "A"}})[0] == 200
    assert call(port, "POST", "/web/state", cookie(SESSION_B), {"files": {"other.txt": "B"}})[0] == 200

    status, _, state_a = json_call(port, "GET", "/web/state", cookie(SESSION_A))
    assert status == 200 and state_a["files"] == {"private.txt": "A"}
    _, _, state_b = json_call(port, "GET", "/web/state", cookie(SESSION_B))
    assert state_b["files"] == {"other.txt": "B"}
    assert web_app.read_state()["files"] == {}


@pytest.mark.parametrize("raw_length,status", [
    ("-1", 400), ("nope", 400), ("1.0", 400), ("１２", 400), ("9" * 5000, 400), ("9", 413),
])
def test_body_rejects_invalid_or_oversized_lengths_before_reading(raw_length, status):
    handler = object.__new__(http_api.Handler)
    handler.headers = {"Content-Length": raw_length}
    handler.close_connection = False
    reads = []

    class Stream:
        def read(self, amount=-1):
            reads.append(amount)
            return b"{}"

    handler.rfile = Stream()
    with pytest.raises(http_api.BodyError) as error:
        handler._body(limit=8)
    assert error.value.status == status
    assert reads == []
    assert handler.close_connection is True


def test_globus_web_state_rejects_negative_content_length(tenant_server):
    port, _, _, _ = tenant_server
    assert call(port, "POST", "/web/state", cookie(SESSION_A), {"files": {"private.txt": "kept"}})[0] == 200
    status, _, data = call(port, "POST", "/web/state", {**cookie(SESSION_A), "Content-Length": "-1"}, {})
    assert status == 400 and json.loads(data) == {"error": "invalid Content-Length"}
    status, _, state = json_call(port, "GET", "/web/state", cookie(SESSION_A))
    assert status == 200 and state["files"] == {"private.txt": "kept"}


def test_agent_token_requires_current_sidecar_secret_and_valid_tenant(tenant_server, capsys):
    port, manager, sidecar, _ = tenant_server
    auth = {"Authorization": f"Bearer {SIDECAR_SECRET}", "X-Veritas-Tenant": TENANT_A}
    status, headers, data = call(port, "GET", "/auth/globus/agent-token?refresh=1", auth)
    assert status == 200 and json.loads(data) == {"access_token": "access-A", "expires_at": 1234}
    assert value(headers, "Cache-Control") == "no-store"
    assert value(headers, "Pragma") == "no-cache"
    assert manager.calls == [(TENANT_A, True)]

    for headers in (
        {"X-Veritas-Tenant": TENANT_A},
        {"Authorization": "Bearer wrong", "X-Veritas-Tenant": TENANT_A},
        {"Authorization": "Bearer admin-token", "X-Veritas-Tenant": TENANT_A},
        {"Authorization": f"Bearer {SIDECAR_SECRET}", "X-Veritas-Tenant": "not-a-tenant"},
    ):
        assert call(port, "GET", "/auth/globus/agent-token", headers)[0] in (401, 403)

    sidecar.secret = "replacement-secret"
    assert call(port, "GET", "/auth/globus/agent-token", auth)[0] == 403
    captured = capsys.readouterr()
    for sentinel in ("access-A", "access-B", "admin-token", SIDECAR_SECRET, SESSION_A):
        assert sentinel not in captured.out + captured.err


def test_agent_token_error_is_safe(tenant_server, capsys):
    port, manager, _, _ = tenant_server
    def fail(tenant, force=False):
        raise globus_auth.AuthError(502, "ALCF Inference refresh failed")
    manager.inference_credential = fail
    status, _, body = call(port, "GET", "/auth/globus/agent-token", {
        "Authorization": f"Bearer {SIDECAR_SECRET}", "X-Veritas-Tenant": TENANT_A,
    })
    assert status == 502 and json.loads(body) == {"error": "ALCF Inference refresh failed"}
    captured = capsys.readouterr()
    assert "access-A" not in captured.out + captured.err
    assert "access-A" not in body.decode()


def test_tenant_library_identity_requires_the_current_sidecar_secret(tenant_server):
    assert http_api.principal(tenant_agent()) == {"kind": "globus-agent", "tenant": TENANT_A}
    assert http_api.principal(operator_agent()) == {"kind": "admin"}
    for headers in (
        {"X-Veritas-Tenant": TENANT_A, "X-KB-Client": "agent"},
        {"Authorization": "Bearer wrong", "X-Veritas-Tenant": TENANT_A, "X-KB-Client": "agent"},
        {"Authorization": f"Bearer {SIDECAR_SECRET}", "X-Veritas-Tenant": "invalid", "X-KB-Client": "agent"},
    ):
        assert http_api.principal(headers) is None


def test_globus_operator_zotero_and_source_routes_are_admin_only(tenant_server):
    port, _, _, _ = tenant_server
    for path in ("/sources", "/zotero?key=PUBLIC01", "/zotero/pdf?key=PUBATT01",
                 "/zotero/items", "/zotero/collections", "/zotero/status",
                 "/paper-note?key=PUBLIC01", "/paper-note/body?key=PUBLIC01"):
        assert call(port, "GET", path, cookie(SESSION_A))[0] == 403, path


def test_globus_search_and_note_reads_hide_all_operator_zotero(library_server, monkeypatch):
    port, _, _, _ = library_server
    hits = [
        {"path": "zotero/PUBLIC01", "title": "Operator paper"},
        {"path": "public.md", "title": "Shared note"},
    ]

    class Results:
        def search(self, *args, **kwargs):
            return hits

    monkeypatch.setattr(http_api, "searcher", lambda: Results())
    monkeypatch.setattr(http_api.kb, "note_path", lambda path: path)
    monkeypatch.setattr(http_api.kb, "read_note", lambda path, *args: {
        "path": path, "title": "Operator paper", "text": "operator Zotero text",
    })

    status, _, body = json_call(port, "GET", "/search?q=paper", cookie(SESSION_A))
    assert status == 200 and body == [hits[1]]
    assert call(port, "GET", "/note?path=zotero/PUBLIC01", cookie(SESSION_A))[0] == 403

    status, _, body = json_call(port, "GET", "/search?q=paper", {"Authorization": "Bearer admin-token"})
    assert status == 200 and body == hits
    assert call(port, "GET", "/note?path=zotero/PUBLIC01", {"Authorization": "Bearer admin-token"})[0] == 200


def test_tenant_agent_cannot_reach_operator_zotero_but_operator_agent_can(library_server, monkeypatch):
    port, _, _, _ = library_server
    hits = [
        {"path": "zotero/PUBLIC01", "title": "Operator paper"},
        {"path": "public.md", "title": "Shared note"},
    ]

    class Results:
        def search(self, *args, **kwargs):
            return hits

        def similar_to_text(self, *args, **kwargs):
            return hits

    results = Results()
    results.db = http_api.kb.connect()
    monkeypatch.setattr(http_api, "searcher", lambda: results)
    monkeypatch.setattr(http_api.kb, "note_path", lambda path: path)
    monkeypatch.setattr(http_api.kb, "read_note", lambda path, *args: {
        "path": path, "title": "Operator paper", "text": "operator Zotero text",
    })

    for tenant in (TENANT_A, TENANT_B):
        auth = tenant_agent(tenant)
        status, _, body = json_call(port, "GET", "/search?q=paper", auth)
        assert status == 200 and body == [hits[1]]
        assert call(port, "GET", "/note?path=zotero/PUBLIC01", auth)[0] == 403
        status, _, body = json_call(port, "GET", "/zotero/items", auth)
        assert status == 200 and body == {"items": []}, body
        status, _, body = json_call(port, "POST", "/similar", auth, {"text": "paper"})
        assert status == 200 and body == [hits[1]]

    status, _, body = json_call(port, "GET", "/search?q=paper", operator_agent())
    assert status == 200 and body == hits
    status, _, body = json_call(port, "GET", "/zotero/items", operator_agent())
    assert status == 200 and {item["key"] for item in body["items"]} == {
        "ATTACH01", "PUBLIC01", "lab:/zotero/PUBLIC01",
    }
