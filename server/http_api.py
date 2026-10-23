"""HTTP API over the index, for the Obsidian plugin on the Mac and on the phone.

GET  /ping                                     is the server up (no database work)
GET  /status                                   index counts
GET  /links?path=...   GET /recent?days=&folder=&limit=
GET  /search?q=...&limit=&source=&exclude_source=&folder=&tag=&collections=K1,K2&year_from=&year_to=
                                                same search the agents use; `collections` takes Zotero collection
                                                keys and includes every descendant collection of each key
GET  /zotero/collections                       the Zotero collection tree: [{key,name,parent,count}]
GET  /related?path=...&limit=                  links, backlinks, similar notes, shared tags
POST /similar   {"text", "path"}               notes closest to a passage (the section being written)
GET  /note?path=...                            a note or Zotero item as text
GET  /zotero?key=...[&full_text=1]             a Zotero item, structured for the reading view
GET  /duplicates                               identical and near-identical notes, duplicate Zotero items
GET  /zotero/status                             per paper: in the index, searchable by meaning, full text included
GET  /zotero/files[?refresh=1]                 plan for broken PDF attachments (computed in the background)
GET  /paper-note?key=...                        the paper's Obsidian note, if any, and what its "My notes" says
POST /paper-note {"key"}                       make the paper's Obsidian note (or refresh its Zotero part)
GET  /paper-note/body?key=...                  the note's "My notes" section, for editing in Zotero
POST /paper-note/body {"key","text","base_hash"}  save it (409 with the current text if Obsidian changed it)
POST /paper-note/refresh {"key"}               re-copy highlights and Zotero notes into the note (after a change)
GET  /file?name=|path=[&note=]                   an image in the vault, for notes shown in Zotero
POST /attachment {"name","data"}               save a pasted image (base64) into Papers/attachments
GET  /zotero/edits                              comments and Zotero notes edited in Obsidian, to write into Zotero
POST /zotero/edits/done {"ids"}                 those were written; refresh the notes
POST /zotero/add {"papers","collection"?,"tag"?}  to Zotero's connector when it runs, else queued: [{status: added|queued|failed}]
POST /zotero/tag {"key"?|"doi"?|"title"?,"tag"}   queue a tag edit (Read later) for the Zotero plugin
POST /zotero/annotate {"key","annotation"}     queue a highlight on the PDF attachment `key` (pending_adds.annotate)
GET  /zotero/pending-adds                      queued adds, tags and collection moves the Zotero plugin has yet to apply
POST /zotero/pending-adds/done {"ids"}         the plugin applied these
POST /zotero/pending-adds/attempt {"id","message"}  it could not; after 5 tries the entry is marked failed
POST /render {"markdown"}                       HTML preview of a note's Markdown
GET  /plugins/zotero/latest                     {version, sha256, url} for the lockstep Zotero xpi (spec 006)
GET  /plugins/zotero/xpi?version=               streams that xpi
GET  /plugins/obsidian/latest                   {version, files: {name: sha256}} for the lockstep Obsidian build
GET  /plugins/obsidian/file?version=&name=      streams one of main.js/manifest.json/styles.css
GET  /conflicts                                sync-conflict copies and whether each matches its original
GET  /skills   GET /skills/<name>              user skills in the vault (Second Brain/Skills/<name>/SKILL.md)
PUT  /skills/<name> {"text"}                   save one (atomic; 413 over 64 KB)
DELETE /skills/<name>                          move it to Skills/.trash (never removed)
GET  /paper-figure?doi=&arxiv=&url=            a paper's graphical abstract or first figure: {image} (paper_figures.py)
GET  /zotero/pdf?key=<attachmentKey>           that PDF from Zotero's storage folder, streamed, with Range (pdf_route.py; not for agents)
GET  /site-icon?domain=|openalex=               a site's own icon (journal, database, feed, outside source), fetched once and kept
GET  /folder-file?path=<index path>              an indexed PDF or image from any listed folder, streamed with Range (spec 018)
GET  /zotero/items?collections=K1,K2          indexed Zotero items in those collections and their descendants (spec 012)
POST /radar/score {"scope","positives","negatives","items"}   similarity to the scope's centroid, and to negatives
POST /radar/profile {"scope"}                   seed profile: top terms, authors, journals of a scope
POST /radar/score {..., "seeds"}               with seeds (spec 021): also seed_max and seed_best (closest seed) per item
POST /radar/fulltext {"seeds","items":[{id,arxiv}]}  new arXiv papers read whole (PDF text, cached) and compared with the seeds
POST /radar/calibrate {"seeds","unrelated"}    thresholds for abstracts and whole papers from seed-seed and seed-unrelated similarity
PUT  /digests/<file> {"text"}                   save Second Brain/Digests/<file>.md (atomic; 413 over 512 KB)
POST /index                                    re-index changed notes now
GET  /setup/suggest                            what a new user could add: Zotero, Obsidian vaults, PDF folders (spec 023)
GET  /sources                                  the folders the index reads, each with kind, role and count (spec 018)
POST /sources {"path","name"?}                 add a folder (400 unreadable/too broad, 409 already listed); starts indexing
POST /sources {"kind":"zotero-web","user_id","key"?,"name"?}  add an online Zotero library (key goes to the Keychain)
PATCH /sources/<name> {"enabled"?,"skip"?}     switch a folder on or off, or set its skip patterns
PATCH /sources/output {"name": str|null}       where notes are written: a listed notes folder, or ~/Documents/Veritas
DELETE /sources/<name>                         take a folder off the list (its rows go on the next index run)
GET  /app, /app/<path>                         the web app: static files from data/web/ (web_app.py); public, also to the phone
GET  /web/phone-link                           the sign-in link for the phone (Mac only; 403 when proxied)
GET  /web/state   POST /web/state {"prefs"?, "files"?}   the web app's settings and small files, merged on save
GET  /web/page?url=&prefer=reader               the link panel: {mode: frame|reader|pdf|blocked}; a DOI goes to the library
                                               PDF, then an open-access PDF, then the abstract (web_page.py, spec 022)
GET  /web/pdf?url=                              that PDF streamed with Range (a DOI: the library's or open-access copy)
POST /web/ticket {"route","query"}             a one-use, 120 s ticket for a frame/PDF/image URL (?ticket=), phase 3
POST /app/login {"token"}                      sign a browser in: sets the `sb_session` cookie (401 on a wrong token)

Listens on 127.0.0.1 only. The phone reaches it through `tailscale serve`, which forwards tailnet requests to this
port with the Tailscale host name in the Host header. `request_class` sorts every request by its headers:
- foreign: another website open in a browser (`Sec-Fetch-Site` cross-site or same-site, or an http(s) `Origin`
  that is not this server's own). Refused with 403 on every route.
- local: addressed to localhost with no proxy headers. That is the Mac itself (plugins, agents, curl); no token.
- proxied: anything else. It needs `Authorization: Bearer <data/api-token>` or an `sb_session` cookie from
  `POST /app/login`.
So a web page cannot use the API, through DNS rebinding or otherwise, and a tailnet device without the token gets
nothing. No CORS headers are sent.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import mimetypes
import os
import re
import secrets
import signal
import sys
import threading
import time
from http.cookies import CookieError, SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Literal, Mapping
from urllib.parse import parse_qs, unquote, urlparse

import agent_api
import kb
import zotero
import zotero_files
import paper_notes
import pending_adds
import plugin_updates
import radar_api
import site_icons
import skills
import setup_suggest
import sources
import paper_figures
import pdf_route
import tickets
import web_origins
import web_app
import web_page

LOCK = threading.Lock()
# What the agents' MCP tools may call; every other route (note editing, files, the Zotero plugin's own routes,
# /agent/* and /ai-note) is for the plugins and the sidecar only. privacy.json still filters what these return.
# Routes that only make sense with a Zotero library (spec 018 G3).
ZOTERO_ONLY = {"/zotero", "/zotero/pdf", "/zotero/files", "/paper-note", "/paper-note/body", "/paper-note/refresh",
               "/zotero/add", "/zotero/tag", "/zotero/annotate"}
AGENT_ROUTES = {"/ping", "/status", "/search", "/related", "/links", "/recent", "/note", "/zotero", "/similar", "/zotero/items", "/radar/score", "/radar/profile", "/radar/fulltext", "/radar/calibrate", "/digests"}  # one SQLite connection and one model, shared by all request threads
SEARCHER: kb.Searcher | None = None
TOKEN_FILE = kb.HOME / "data" / "api-token"
LOCAL_HOSTS = ("127.0.0.1", "localhost")
CONFLICT = re.compile(r"\.conflict-macos-(\d{8}T\d{6}Z)\.md$")
AGENT_SIDECAR: agent_api.Sidecar | None = None  # set by serve(); None means /agent/* answers 503


def token() -> str:
    if not TOKEN_FILE.exists():
        TOKEN_FILE.write_text(secrets.token_urlsafe(32))
        os.chmod(TOKEN_FILE, 0o600)
    return TOKEN_FILE.read_text().strip()


RequestClass = Literal["foreign", "proxied", "local", "app"]
PROXY_HEADERS = ("x-forwarded-", "tailscale-", "forwarded")
SESSIONS_FILE = kb.HOME / "data" / "web" / "sessions.json"
SESSION_SECONDS = 365 * 24 * 3600
SESSION_COOKIE = "sb_session"
_sessions_lock = threading.Lock()


def request_class(headers: Mapping[str, str]) -> RequestClass:
    h = {name.lower(): value for name, value in headers.items()}
    host = h.get("host", "")
    proxied = any(name.startswith(PROXY_HEADERS) for name in h)
    local = host.rsplit(":", 1)[0] in LOCAL_HOSTS and not proxied
    # Behind tailscale serve the page may be on http:// or https:// (an http port does not always say which);
    # either scheme on this same host is this app, not another website.
    own_origins = {f"http://{host}", f"https://{host}"} if proxied else {f"http://{host}"} if local else set()
    origin = h.get("origin", "")
    # A listed web-app origin (the hosted web app, a Tauri window; web_origins.py): CORS, and the token always.
    if origin and origin != "null":
        try:
            if web_origins.normalise(origin) in web_origins.allowed():
                return "app"
        except ValueError:
            pass
    # Only http(s) origins are websites; the plugins send no Origin, or an app:// / "null" one.
    if h.get("sec-fetch-site") in ("cross-site", "same-site") or (
            origin.startswith(("http://", "https://")) and origin not in own_origins):
        return "foreign"
    return "local" if local else "proxied"


def _session_hash(session: str) -> str:
    return hashlib.sha256(session.encode()).hexdigest()


def _sessions() -> dict:
    try:
        return json.loads(SESSIONS_FILE.read_text())
    except (OSError, ValueError):
        return {}


def new_session() -> str:
    session = secrets.token_urlsafe(32)
    with _sessions_lock:
        now = time.time()
        sessions = {k: v for k, v in _sessions().items() if now - v.get("created", 0) < SESSION_SECONDS}
        sessions[_session_hash(session)] = {"created": now}
        SESSIONS_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = SESSIONS_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(sessions))
        os.chmod(tmp, 0o600)
        os.replace(tmp, SESSIONS_FILE)
    return session


def bearer_ok(headers: Mapping[str, str]) -> bool:
    """The Authorization: Bearer header carries this server's token."""
    sent = (headers.get("Authorization") or "").removeprefix("Bearer ").strip()
    return bool(sent) and hmac.compare_digest(sent.encode(), token().encode())


def authorized(headers: Mapping[str, str]) -> bool:
    """A Bearer token or a live sb_session cookie."""
    if bearer_ok(headers):
        return True
    try:
        morsel = SimpleCookie(headers.get("Cookie") or "").get(SESSION_COOKIE)
    except CookieError:
        return False
    if not morsel or not morsel.value:
        return False
    created = _sessions().get(_session_hash(morsel.value), {}).get("created", 0)
    return time.time() - created < SESSION_SECONDS


def searcher() -> kb.Searcher:
    global SEARCHER
    if SEARCHER is None:
        SEARCHER = kb.Searcher(writer=True)
    return SEARCHER


_conflicts: dict = {}


def conflicts() -> dict:
    """Each sync-conflict copy next to its original: identical (safe to remove) or different (needs a look).
    Cached until the set of conflict files changes."""
    found = []
    for root, dirs, names in os.walk(kb.VAULT):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        found += [os.path.join(root, n) for n in names if CONFLICT.search(n)]
    signature = (len(found), max((os.stat(f).st_mtime for f in found), default=0))
    if _conflicts.get("signature") == signature:
        return _conflicts["result"]
    identical, different, orphaned = [], [], []
    for copy in sorted(found):
        original = CONFLICT.sub(".md", copy)
        rel_copy = os.path.relpath(copy, kb.VAULT)
        rel_original = os.path.relpath(original, kb.VAULT)
        if not os.path.exists(original):
            orphaned.append({"copy": rel_copy})
            continue
        a, b = Path(copy).read_bytes(), Path(original).read_bytes()
        entry = {"copy": rel_copy, "original": rel_original, "copy_chars": len(a), "original_chars": len(b),
                 "copy_newer": os.stat(copy).st_mtime > os.stat(original).st_mtime}
        (identical if a == b else different).append(entry)
    result = {"total": len(found), "identical": identical, "different": different, "no_original": orphaned}
    _conflicts.update(signature=signature, result=result)
    return result


_coverage: dict = {}


def index_status() -> dict:
    """For the plugin's status panel: counts per source (cached 20 s), what indexing is doing now, and when the
    next automatic check runs."""
    if time.time() - _coverage.get("at", 0) > 20:
        _coverage.update(at=time.time(), rows=kb.coverage(), stats=kb.stats())
    try:
        progress = json.loads(kb.PROGRESS_FILE.read_text())
    except (OSError, ValueError):
        progress = {}
    running = kb.index_running()
    if not running and progress.get("running"):  # the process died without finishing
        progress.update(running=False, stage="idle", label="Interrupted")
    return {**_coverage["stats"], "coverage": _coverage["rows"], "indexing": progress, "running": running,
            "next_check_at": LAST_CHECK["at"] + kb.FRESH_EVERY if LAST_CHECK["at"] else None}


LAST_CHECK = {"at": 0.0}
_zotero_status: dict = {"at": 0.0}


def zotero_status() -> dict:
    """Index state of every Zotero paper, for the plugin's column: "meaning" (every passage has a vector),
    "keywords" (indexed, vectors still being made), and whether the PDF's full text is in. Cached 60 s."""
    if time.time() - _zotero_status["at"] > 60:
        db = kb.connect()
        try:
            rows = db.execute(
                """SELECT substr(c.path, 8), c.n, coalesce(v.n, 0), c.full_text FROM
                     (SELECT path, count(*) n, max(heading LIKE '%Full text%') full_text FROM chunks
                      WHERE path >= 'zotero/' AND path < 'zotero0' GROUP BY path) c
                   LEFT JOIN (SELECT path, count(*) n FROM vecs WHERE path >= 'zotero/' AND path < 'zotero0'
                              GROUP BY path) v ON v.path = c.path""").fetchall()
        finally:
            db.close()
        _zotero_status.update(at=time.time(), items={
            key: {"state": "meaning" if with_vec == n else "keywords", "full_text": bool(full)}
            for key, n, with_vec, full in rows})
    return {"updated_at": _zotero_status["at"], "items": _zotero_status["items"]}


_files_job: dict = {"running": False, "done": 0, "total": 0, "error": None}
_files_lock = threading.Lock()


def zotero_files_plan(refresh: bool) -> dict:
    """The relink plan if one is fresh (30 min), else start computing it and report progress."""
    fresh = zotero_files.PLAN.exists() and time.time() - zotero_files.PLAN.stat().st_mtime < 1800
    if fresh and not refresh and not _files_job["running"]:
        return {"ready": True, "plan": json.loads(zotero_files.PLAN.read_text())}
    with _files_lock:
        if _files_job["running"]:
            return {"ready": False, **_files_job}

        def work() -> None:
            kb.background_priority()
            try:
                zotero_files.plan(lambda n, total: _files_job.update(done=n, total=total))
            except Exception as error:  # noqa: BLE001 - reported to the plugin
                _files_job["error"] = str(error)
            finally:
                _files_job["running"] = False
        _files_job.update(running=True, done=0, total=0, error=None)
        threading.Thread(target=work, daemon=True).start()
        return {"ready": False, **_files_job}


def sources_changed() -> None:
    """After the folder list changed: this process follows it now, and an index run applies it."""
    kb.reload_layout()
    _coverage.clear()
    if not kb.index_running():
        start_indexing(None)


def start_indexing(reread: str | None) -> None:
    """A separate process, so a long run (re-reading every image) outlives server restarts and can be stopped."""
    # taskpolicy -b: background priority, like the indexing threads (kb.background_priority)
    args = ["/usr/sbin/taskpolicy", "-b", sys.executable, str(kb.HOME / "kb.py"), "index"]
    if reread == "zotero":
        args.append("--reread-zotero")
    elif reread == "media":
        args.append("--reread-media")
    log = open(kb.HOME / "data" / "index.log", "a")
    import subprocess

    subprocess.Popen(args, cwd=kb.HOME, start_new_session=True, stdin=subprocess.DEVNULL, stdout=log, stderr=log)
    _coverage.clear()


def stop_indexing() -> bool:
    """Asks the indexing process to stop after its current batch. Work done so far is kept."""
    try:
        pid = json.loads(kb.PROGRESS_FILE.read_text()).get("pid")
    except (OSError, ValueError):
        return False
    if not pid or not kb.index_running():
        return False
    if pid == os.getpid():
        kb.STOP.set()  # the automatic check running inside this server
    else:
        import signal

        os.kill(pid, signal.SIGTERM)
    return True


def _year(value: str | None) -> int | None:
    """A year query parameter: a 4-digit number, anything else (absent, blank, junk) means no bound."""
    return int(value) if value and value.strip().isdigit() and len(value.strip()) == 4 else None


def _without(related: dict, hidden: set[str]) -> dict:
    """A related/links result with private notes taken out of every list."""
    out = dict(related)
    for key in ("links_to", "linked_from"):
        if key in out:
            out[key] = [p for p in out[key] if p not in hidden]
    for key in ("similar", "shared_tags"):
        if key in out:
            out[key] = [r for r in out[key] if r["path"] not in hidden]
    if "refs" in out:
        out["refs"] = {p: r for p, r in out["refs"].items() if p not in hidden}
    return out


# The plugins are parts of the same repo, beside server/ (kb.HOME).
ZOTERO_DIST = kb.HOME.parent / "zotero" / "dist"
OBSIDIAN_DIST = kb.HOME.parent / "obsidian" / "dist-versions"

AUDIT_FILE = kb.HOME / "data" / "agent-access.log"


def audit(route: str, params: dict, result: object) -> None:
    """One line per agent request: when, what was asked, which notes came back and how much text (~4 chars
    per token). `kb.py audit` summarises it."""
    if isinstance(result, list):
        paths = [r.get("path") for r in result if isinstance(r, dict)]
    elif isinstance(result, dict):
        paths = [result.get("path")] if result.get("path") else []
    else:
        paths = []
    entry = {"at": time.strftime("%Y-%m-%d %H:%M:%S"), "route": route,
             "asked": {k: v for k, v in params.items() if k in ("q", "path", "key", "heading", "days", "text", "offset")},
             "notes": [p for p in paths if p][:20], "chars": len(json.dumps(result, ensure_ascii=False))}
    with AUDIT_FILE.open("a") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


class Handler(BaseHTTPRequestHandler):
    def _needs_zotero(self, route: str) -> bool:
        """A setup without a Zotero library (spec 018): one item, its PDF, its note and every write to Zotero answer
        409 needs_zotero. The lists (collections, items, status, edits, pending adds) stay, empty."""
        if route not in ZOTERO_ONLY or zotero.ZOTERO.is_dir():
            return False
        self._send(409, {"error": "needs_zotero", "message": "Needs Zotero: add your Zotero folder in Settings > Folders"})
        return True

    def _send(self, status: int, body: object, headers: dict | None = None) -> None:
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _send_file(self, path: Path) -> None:
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", paper_notes.IMAGE_TYPES.get(path.suffix.lower(), "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "max-age=300")
        self.end_headers()
        self.wfile.write(data)

    def _send_binary(self, path: Path, content_type: str) -> None:
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    _cors_origin: str | None = None  # set per request for a listed web-app origin; end_headers adds the CORS headers

    def end_headers(self) -> None:
        if self._cors_origin:
            self.send_header("Access-Control-Allow-Origin", self._cors_origin)
            self.send_header("Vary", "Origin")
        super().end_headers()

    def do_OPTIONS(self) -> None:
        """CORS preflight: answered for listed web-app origins only."""
        self._cors_origin = None
        if request_class(self.headers) != "app":
            return self._send(403, {"error": "requests from other websites are refused"})
        self._cors_origin = self.headers.get("Origin")
        self.send_response(204)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Max-Age", "600")
        if self.headers.get("Access-Control-Request-Private-Network") == "true":
            # Chrome asks before a public page may reach a server on this computer or the home network.
            self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _allowed(self) -> bool:
        kind = request_class(self.headers)
        self._cors_origin = self.headers.get("Origin") if kind == "app" else None
        # A frame or PDF.js request of the hosted web app: no token header, a one-use ticket in the URL instead
        # (tickets.py). Checked before the other-website refusal, because a cross-site frame looks like one.
        if self.command == "GET":
            parsed = urlparse(self.path)
            q = {k: v[0] for k, v in parse_qs(parsed.query).items()}
            if q.get("ticket") and parsed.path in tickets.ROUTES:
                if tickets.redeem(q["ticket"], parsed.path, q):
                    return True
                self._send(403, {"error": "this link has expired; open it again"})
                return False
        if kind == "app":
            # Never the loopback pass or the cookie: a listed site still has to prove it holds the token.
            if bearer_ok(self.headers):
                return True
            self._send(401, {"error": "a valid token is required"})
            return False
        if kind == "foreign":
            # Logged so a real client that gets wrongly classed as a website shows up in serve.log.
            print(f"403 foreign {self.command} {urlparse(self.path).path} origin={self.headers.get('Origin')!r} "
                  f"sec-fetch-site={self.headers.get('Sec-Fetch-Site')!r}", file=sys.stderr, flush=True)
            self._send(403, {"error": "requests from other websites are refused"})
            return False
        path = urlparse(self.path).path
        # The page, its scripts and the sign-in page are public files; every data route stays behind the token.
        public = (self.command == "POST" and path == "/app/login") or (self.command == "GET" and (path == "/app" or path.startswith("/app/")))
        if kind == "local" or public or authorized(self.headers):
            return True
        self._send(401, {"error": "a valid token is required"})
        return False

    def _query(self) -> dict:
        return {k: v[0] for k, v in parse_qs(urlparse(self.path).query).items()}

    def _body(self, limit: int = 1_000_000) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(min(length, limit)) or b"{}")

    def _run(self, handler) -> None:
        try:
            with kb.request_scope():
                handler()
        except FileNotFoundError as error:
            self._send(404, {"error": str(error)})
        except PermissionError as error:
            # our own refusals explain themselves; an OS error would name a path on this Mac
            self._send(403, {"error": str(error) if error.filename is None else "permission denied"})
        except Exception as error:  # report, keep serving
            detail = f"{type(error).__name__}: {error}" if not isinstance(error, OSError) else type(error).__name__
            self._send(500, {"error": detail})

    def _agent(self) -> bool:
        """Requests from the agents' MCP tools say so; privacy.json applies to them (the plugin sees everything)."""
        return self.headers.get("X-KB-Client") == "agent"

    def _forward_to_agent_sidecar(self, route: str) -> bool:
        """True if this request was /agent/* and has been handled (forwarded or answered 503). The check above
        (agent and route not in AGENT_ROUTES) already blocks an agent's own MCP calls from reaching here, since
        neither /agent nor /ai-note is in AGENT_ROUTES."""
        if route != "/agent" and not route.startswith("/agent/"):
            return False
        agent_api.forward(self, AGENT_SIDECAR, self.command, self.path[len("/agent"):] or "/")
        return True

    def do_GET(self) -> None:
        if not self._allowed():
            return
        route, q = urlparse(self.path).path, self._query()
        agent = self._agent()
        rules = kb.privacy() if agent else {}
        hidden = kb.private_paths() if agent else set()

        def guard(path: str) -> str:
            rel = kb.note_path(path)
            if rel in hidden:
                raise PermissionError("this note is marked private (privacy.json)")
            return rel

        def handle() -> None:
            if agent and route not in AGENT_ROUTES:
                raise PermissionError("not available to agents")
            if self._forward_to_agent_sidecar(route):
                return
            if self._needs_zotero(route):
                return
            if route == "/ping":
                return self._send(200, {"ok": True})
            if route == "/app" or route.startswith("/app/"):
                return web_app.serve(self, route)
            if route == "/web/phone-link":
                if request_class(self.headers) != "local":  # the token must never reach the phone side
                    return self._send(403, {"error": "only on the Mac itself"})
                return self._send(200, web_app.phone_link(token(), self.server.server_address[1]))
            if route == "/status":
                result = index_status()
            elif route == "/setup/suggest":
                result = setup_suggest.suggest()
            elif route == "/sources":
                result = kb.sources_report()
            elif route == "/search":
                limit = min(int(q.get("limit", 20)), 200)
                if agent:
                    limit = min(limit, int(rules.get("agent_search_max_results", 10)))
                with LOCK:
                    # Ask for extra when some notes are private, so filtering still leaves `limit` results.
                    hits = searcher().search(q.get("q", ""), limit * 2 if hidden else limit, q.get("source") or None,
                                             q.get("folder") or None, q.get("tag") or None,
                                             exclude_source=q.get("exclude_source") or None,
                                             collections=[k for k in q.get("collections", "").split(",") if k] or None,
                                             year_from=_year(q.get("year_from")), year_to=_year(q.get("year_to")))
                result = [h for h in hits if h["path"] not in hidden][:limit]
            elif route == "/related":
                with LOCK:
                    result = searcher().related(guard(q["path"]), int(q.get("limit", 10)))
                if hidden:
                    result = _without(result, hidden)
            elif route == "/links":
                result = kb.links(guard(q["path"]))
                if hidden:
                    result = _without(result, hidden)
            elif route == "/recent":
                result = [r for r in kb.recent(int(q.get("days", 7)), q.get("folder") or None, int(q.get("limit", 50)))
                          if r["path"] not in hidden]
            elif route == "/note":
                max_chars = min(int(q.get("max_chars", 60000)), 2_000_000)
                if agent:
                    max_chars = min(max_chars, int(rules.get("agent_read_max_chars", 12000)))
                result = kb.read_note(guard(q["path"]), q.get("heading"), max_chars, int(q.get("offset", 0)))
            elif route == "/zotero":
                lib, key = kb.zotero_ref(q["key"])
                guard(q["key"] if ":/" in q["key"] else zotero.PREFIX + key)
                with zotero.library(lib):
                    result = zotero.item_detail(key, full_text=q.get("full_text") == "1")
                if result is None:
                    raise FileNotFoundError(f"no Zotero item {key!r}")
            elif route == "/zotero/pdf":
                lib = kb.zotero_ref(q["library"] + ":/")[0] if q.get("library") else zotero.ZOTERO
                with zotero.library(lib):
                    return pdf_route.serve(self, q.get("key", ""))
            elif route == "/site-icon":
                try:
                    found = site_icons.site_icon(domain=q.get("domain") or None, openalex=q.get("openalex") or None)
                except site_icons.Refused as error:
                    return self._send(400, {"error": str(error)})
                if not found:
                    return self._send(404, {"error": "no icon"})
                path, kind = found
                data = path.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", kind)
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "private, max-age=86400")
                # an SVG from another site, served from ours: never a document that can run anything
                self.send_header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.end_headers()
                self.wfile.write(data)
                return
            elif route == "/web/page":
                result = web_page.page(q.get("url", ""), q.get("prefer"))
            elif route == "/web/pdf":
                try:
                    found = web_page.pdf_file(q.get("url", ""))
                except web_page.Refused as error:
                    return self._send(400, {"error": str(error)})
                except pdf_route.Refused as refusal:
                    return self._send(refusal.status, {"error": refusal.message})
                except ValueError as error:
                    return self._send(415, {"error": str(error)})
                except OSError:
                    return self._send(502, {"error": "Second Brain couldn't reach the site."})
                return pdf_route.stream(self, found, "application/pdf")
            elif route == "/folder-file":
                found = kb.document_file(q.get("path", ""))
                kind = mimetypes.guess_type(found.name)[0] or "application/octet-stream"
                return pdf_route.stream(self, found, kind)
            elif route == "/paper-figure":
                result = {"image": paper_figures.figure(q.get("doi", ""), q.get("arxiv"), q.get("url"))}
            elif route == "/web/state":
                result = web_app.read_state()
            elif route == "/zotero/edits":
                result = paper_notes.pending_edits()
            elif route == "/zotero/pending-adds":
                result = pending_adds.pending()
            elif route == "/zotero/status":
                result = zotero_status()
            elif route == "/zotero/collections":
                result = kb.zotero_collections()
            elif route == "/zotero/items":
                with LOCK:
                    result = radar_api.items(searcher().db, [k for k in q.get("collections", "").split(",") if k] or None, hidden,
                                            slim=q.get("fields") == "slim")
            elif route == "/zotero/files":
                result = zotero_files_plan(q.get("refresh") == "1")
            elif route == "/file":
                found = paper_notes.image_file(q.get("name"), q.get("path"), q.get("note"))
                if not found:
                    return self._send(404, {"error": "no such image"})
                return self._send_file(found)
            elif route == "/paper-note/body":
                result = paper_notes.body(q["key"].removeprefix(zotero.PREFIX))
            elif route == "/paper-note":
                result = paper_notes.summary(q["key"].removeprefix(zotero.PREFIX))
            elif route == "/plugins/zotero/latest":
                result = plugin_updates.latest_zotero(ZOTERO_DIST, OBSIDIAN_DIST)
                if result is None:
                    raise FileNotFoundError("no lockstep version available")
            elif route == "/plugins/zotero/xpi":
                found = plugin_updates.zotero_xpi_path(ZOTERO_DIST, OBSIDIAN_DIST, q.get("version", ""))
                if not found:
                    return self._send(404, {"error": "no such version"})
                return self._send_binary(found, "application/x-xpinstall")
            elif route == "/plugins/obsidian/latest":
                result = plugin_updates.latest_obsidian(ZOTERO_DIST, OBSIDIAN_DIST)
                if result is None:
                    raise FileNotFoundError("no lockstep version available")
            elif route == "/plugins/obsidian/file":
                found = plugin_updates.obsidian_file_path(ZOTERO_DIST, OBSIDIAN_DIST, q.get("version", ""), q.get("name", ""))
                if not found:
                    return self._send(404, {"error": "no such file"})
                content_type = {"main.js": "application/javascript", "manifest.json": "application/json",
                                 "styles.css": "text/css"}[found.name]
                return self._send_binary(found, content_type)
            elif route == "/skills":
                result = skills.list_skills()
            elif route.startswith("/skills/"):
                try:
                    result = skills.get_skill(unquote(route[len("/skills/"):]))
                except skills.BadName as error:
                    return self._send(400, {"error": str(error)})
                if result is None:
                    raise FileNotFoundError("no such skill")
            elif route == "/duplicates":
                with LOCK:
                    result = searcher().duplicates()
            elif route == "/conflicts":
                result = conflicts()
            else:
                return self._send(404, {"error": "not found"})
            self._send(200, result)
            if agent:
                audit(route, q, result)

        self._run(handle)

    def do_POST(self) -> None:
        if not self._allowed():
            return
        route = urlparse(self.path).path
        agent = self._agent()

        def handle() -> None:
            if agent and route not in AGENT_ROUTES:
                raise PermissionError("not available to agents")
            if self._forward_to_agent_sidecar(route):
                return
            if self._needs_zotero(route):
                return
            if route == "/web/ticket":
                body = self._body()
                query = body.get("query") or {}
                if not isinstance(query, dict):
                    return self._send(400, {"error": "query is an object"})
                try:
                    ticket = tickets.issue(str(body.get("route", "")), query)
                except ValueError as error:
                    return self._send(400, {"error": str(error)})
                return self._send(200, {"ticket": ticket, "expires_in": int(tickets.TTL)})
            if route == "/app/login":
                if not hmac.compare_digest(str(self._body().get("token", "")).encode(), token().encode()):
                    return self._send(401, {"error": "wrong token"})
                # Safari drops a Secure cookie set over plain http (a tailscale serve http:// port), and that hop is inside WireGuard anyway
                secure = " Secure;" if self.headers.get("X-Forwarded-Proto") == "https" else ""
                cookie = f"{SESSION_COOKIE}={new_session()}; HttpOnly;{secure} SameSite=Strict; Path=/; Max-Age={SESSION_SECONDS}"
                return self._send(200, {"ok": True}, {"Set-Cookie": cookie})
            if route == "/ai-note":
                body = self._body()
                result = agent_api.create_ai_note(body["folder"], body["title"], body["markdown"], body["reviewId"], body.get("frontMatter"))
                return self._send(200, result)
            if route == "/sources":
                body = self._body()
                if body.get("kind") == "zotero-web":  # an online library: {"kind", "user_id", "key"?, "name"?}
                    try:
                        entry = sources.add_account("zotero-web", str(body.get("user_id", "")),
                                                    key=body.get("key") or None, name=body.get("name") or None)
                    except sources.DuplicateSource as error:
                        return self._send(409, {"error": str(error)})
                    except sources.SourceError as error:
                        return self._send(400, {"error": str(error)})
                    sources_changed()
                    return self._send(201, {"name": entry["name"], "kind": entry["kind"], **kb.sources_report()})
                try:
                    folder = sources.add(str(body.get("path", "")), body.get("name") or None)
                except sources.DuplicateSource as error:
                    return self._send(409, {"error": str(error)})
                except sources.SourceError as error:
                    return self._send(400, {"error": str(error)})
                sources_changed()
                return self._send(201, {"name": folder.name, "kind": folder.kind, **kb.sources_report()})
            if route == "/index":
                body = self._body()
                if kb.index_running():
                    return self._send(409, {"error": "indexing is already running"})
                start_indexing(body.get("reread"))
                self._send(202, {"started": True})
            elif route == "/paper-note":
                result = paper_notes.create(self._body()["key"].removeprefix(zotero.PREFIX))
                self._send(200, result)
            elif route == "/attachment":
                body = self._body(limit=40_000_000)  # base64 of an image up to 25 MB
                self._send(200, {"name": paper_notes.save_image(body.get("name", ""), body["data"])})
            elif route == "/zotero/edits/done":
                paper_notes.edits_done(self._body().get("ids", []))
                self._send(200, {"ok": True})
            elif route == "/zotero/add":
                body = self._body(limit=8_000_000)
                papers = body.get("papers")
                if not isinstance(papers, list) or len(papers) > 200:
                    return self._send(400, {"error": "papers must be a list of up to 200"})
                self._send(200, {"results": pending_adds.add_papers(papers, body.get("collection"), body.get("tag"))})
            elif route == "/zotero/tag":
                body = self._body()
                try:
                    self._send(200, pending_adds.tag_item(body.get("key"), body.get("doi"), body.get("title"), body.get("tag")))
                except ValueError as error:
                    self._send(400, {"error": str(error)})
            elif route == "/zotero/annotate":
                body = self._body()
                try:
                    self._send(200, pending_adds.annotate(body.get("key"), body.get("annotation")))
                except ValueError as error:
                    self._send(400, {"error": str(error)})
            elif route == "/zotero/pending-adds/done":
                pending_adds.done(self._body().get("ids", []))
                self._send(200, {"ok": True})
            elif route == "/zotero/pending-adds/attempt":
                body = self._body()
                self._send(200, {"ok": pending_adds.attempt(str(body.get("id", "")), str(body.get("message", ""))) is not None})
            elif route == "/paper-note/refresh":
                key = self._body()["key"].removeprefix(zotero.PREFIX)
                self._send(200, {"changed": paper_notes.refresh(key, fresh=True)})
            elif route in ("/paper-note/body", "/render"):
                body = self._body()
                if route == "/render":
                    return self._send(200, {"html": paper_notes.render(body.get("markdown", ""))})
                try:
                    result = paper_notes.save(body["key"].removeprefix(zotero.PREFIX), body.get("text", ""),
                                              body.get("base_hash"), bool(body.get("force")))
                except paper_notes.Conflict as conflict:
                    return self._send(409, {"error": str(conflict), **conflict.current})
                self._send(200, result)
            elif route == "/index/stop":
                self._send(200, {"stopping": stop_indexing()})
            elif route == "/web/state":
                if int(self.headers.get("Content-Length") or 0) > web_app.MAX_BODY:
                    return self._send(413, {"error": "too large"})
                try:
                    self._send(200, web_app.update_state(self._body(limit=web_app.MAX_BODY)))
                except web_app.Refused as refused:
                    self._send(refused.status, {"error": refused.message})
                except json.JSONDecodeError:
                    self._send(400, {"error": "invalid JSON"})
            elif route == "/similar":
                body = self._body()
                with LOCK:
                    result = searcher().similar_to_text(body.get("text", ""), body.get("path"), int(body.get("limit", 8)))
                if agent:
                    hidden = kb.private_paths()
                    result = [r for r in result if r["path"] not in hidden]
                    audit(route, {"text": body.get("text", "")[:80]}, result)
                self._send(200, result)
            elif route in ("/radar/score", "/radar/profile", "/radar/fulltext", "/radar/calibrate"):
                body = self._body(limit=8_000_000)
                hidden = kb.private_paths() if agent else set()
                try:
                    if route == "/radar/score":
                        result = radar_api.score(searcher(), body, LOCK, hidden)
                    elif route == "/radar/fulltext":
                        result = radar_api.fulltext(searcher(), body, LOCK, hidden)
                    elif route == "/radar/calibrate":
                        result = radar_api.calibrate(searcher(), body, LOCK, hidden)
                    else:
                        with LOCK:
                            seeds = body.get("seeds")
                            result = radar_api.profile(searcher().db, (body.get("scope") or {}).get("collections"), hidden,
                                                       keys=list(seeds.get("keys") or []) if isinstance(seeds, dict) else None)
                except ValueError as error:
                    return self._send(400, {"error": str(error)})
                self._send(200, result)
            else:
                self._send(404, {"error": "not found"})

        self._run(handle)

    def do_PUT(self) -> None:
        """Only /skills/<name> and /digests/<file> use PUT."""
        if not self._allowed():
            return
        route = urlparse(self.path).path

        def handle() -> None:
            if self._agent() and not route.startswith("/digests/"):
                raise PermissionError("not available to agents")
            if route.startswith("/digests/"):
                try:
                    result = radar_api.put_digest(unquote(route[len("/digests/"):]), str(self._body(limit=radar_api.DIGEST_MAX_BYTES * 2).get("text", "")))
                except radar_api.BadName as error:
                    return self._send(400, {"error": str(error)})
                except radar_api.TooLarge as error:
                    return self._send(413, {"error": str(error)})
                return self._send(200, result)
            if not route.startswith("/skills/"):
                return self._send(404, {"error": "not found"})
            try:
                result = skills.put_skill(unquote(route[len("/skills/"):]), str(self._body(limit=skills.MAX_BYTES * 2).get("text", "")))
            except skills.BadName as error:
                return self._send(400, {"error": str(error)})
            except skills.TooLarge as error:
                return self._send(413, {"error": str(error)})
            self._send(200, result)

        self._run(handle)

    def do_DELETE(self) -> None:
        """/agent/* (removing a conversation or an MCP server) and /skills/<name> use DELETE; nothing else does."""
        if not self._allowed():
            return
        route = urlparse(self.path).path
        agent = self._agent()

        def handle() -> None:
            if agent and route not in AGENT_ROUTES:
                raise PermissionError("not available to agents")
            if self._forward_to_agent_sidecar(route):
                return
            if route.startswith("/sources/"):
                try:
                    sources.remove(unquote(route[len("/sources/"):]))
                except KeyError:
                    raise FileNotFoundError("no such folder in the list") from None
                sources_changed()
                return self._send(200, kb.sources_report())
            if route.startswith("/skills/"):
                try:
                    moved = skills.trash_skill(unquote(route[len("/skills/"):]))
                except skills.BadName as error:
                    return self._send(400, {"error": str(error)})
                if not moved:
                    raise FileNotFoundError("no such skill")
                return self._send(200, {"ok": True})
            self._send(404, {"error": "not found"})

        self._run(handle)

    def do_PATCH(self) -> None:
        """Only /sources/<name> uses PATCH: {"enabled"?, "skip"?}; /sources/output takes {"name": str | null}."""
        if not self._allowed():
            return
        route = urlparse(self.path).path

        def handle() -> None:
            if self._agent():
                raise PermissionError("not available to agents")
            if not route.startswith("/sources/"):
                return self._send(404, {"error": "not found"})
            body = self._body()
            if route == "/sources/output":
                try:
                    sources.set_output(body.get("name") or None)
                except sources.SourceError as error:
                    return self._send(400, {"error": str(error)})
                sources_changed()
                return self._send(200, kb.sources_report())
            skip = body.get("skip")
            if skip is not None and not (isinstance(skip, list) and all(isinstance(x, str) for x in skip)):
                return self._send(400, {"error": "skip is a list of patterns such as \"drafts/*\""})
            try:
                sources.update(unquote(route[len("/sources/"):]),
                               enabled=None if "enabled" not in body else bool(body["enabled"]), skip=skip)
            except KeyError:
                raise FileNotFoundError("no such folder in the list") from None
            sources_changed()
            self._send(200, kb.sources_report())

        self._run(handle)

    def log_message(self, *args) -> None:  # quiet
        pass


def restart_when_code_changes() -> None:
    """A server outlives the Obsidian that started it and serves the phone, so after an update it replaces itself
    with the new code (same process, same port) instead of leaving the phone with nothing."""
    files = [kb.HOME / name for name in ("kb.py", "http_api.py", "zotero.py", "mlx_embed.py", "keyword_index.py", "media.py", "zotero_files.py", "paper_notes.py", "agent_api.py", "plugin_updates.py", "skills.py", "radar_api.py", "web_app.py", "pdf_route.py", "pending_adds.py", "paper_figures.py", "sources.py", "site_icons.py")]
    files.append(kb.HOME / agent_api.AGENTD_ENTRY)  # a rebuilt sidecar is an update too
    started = {f: f.stat().st_mtime for f in files if f.exists()}
    while True:
        time.sleep(30)
        if any(f.exists() and f.stat().st_mtime != m for f, m in started.items()):
            time.sleep(2)  # let an editor finish writing the other files
            agent_api.shutdown(AGENT_SIDECAR)  # swapping the process image won't stop this child on its own
            os.execv(sys.executable, [sys.executable, *sys.argv])


def sidecar_kb_url(port: int) -> str:
    return f"http://127.0.0.1:{int(port)}"


def serve(port: int) -> None:
    global AGENT_SIDECAR
    token()  # create it on first start, so the Mac plugin can hand it to the phone
    try:
        # The sidecar reaches the library through this server, on the port it actually runs on (it used to be told
        # 27182 whatever the port, so a server on another port gave an AI that could not see the library).
        AGENT_SIDECAR = agent_api.supervise(kb.HOME / "data" / "agent", sidecar_kb_url(port))
    except Exception as error:  # the agent sidecar is optional; search must come up either way
        print(f"agent sidecar disabled: {error}", file=sys.stderr)
        AGENT_SIDECAR = None
    # launchd (and kill) stop the server with SIGTERM; the agent sidecar is a child that would otherwise live on,
    # still ticking routines, next to the server that replaces this one.
    def stop(*_):
        agent_api.shutdown(AGENT_SIDECAR)
        os._exit(0)
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    threading.Thread(target=restart_when_code_changes, daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=kb.keep_fresh, kwargs={"on_check": lambda: LAST_CHECK.update(at=time.time())},
                     daemon=True).start()
    threading.Thread(target=lambda: searcher().search("warm up"), daemon=True).start()  # load model + vectors now
    server.serve_forever()
