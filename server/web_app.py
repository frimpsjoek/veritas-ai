"""The web app's server side (spec 013 W1): the built bundle under data/web/ and the small state file the app keeps.

    GET  /app, /app/<path>   static files from data/web/ (no LOCK: reading a file never waits on search)
    GET  /app/login          the sign-in page (login.html); the phone posts its token to POST /app/login
    GET  /web/state          {"prefs": {...}, "files": {name: text}}
    POST /web/state          {"prefs"?: {...}, "files"?: {...}} merged in; a null value removes that key

The state file and the files the server itself keeps next to the bundle are never served as static files.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
from pathlib import Path
from urllib.parse import unquote, urlencode

import kb

WEB_DIR = kb.HOME / "data" / "web"
STATE_NAME = "state.json"
APP_URL_FILE = kb.HOME / "data" / "web-app-url"
# Kept in WEB_DIR by the server (state, sign-in sessions, queued adds); a request for them is a 404, not a download.
PRIVATE = {STATE_NAME, "sessions.json", "pending-adds.json"}
MAX_FILE_BYTES = 256 * 1024
MAX_FILES_BYTES = 2 * 1024 * 1024
MAX_PREFS_BYTES = 256 * 1024
MAX_BODY = MAX_FILES_BYTES + MAX_PREFS_BYTES + 64 * 1024

TYPES = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
    ".webmanifest": "application/manifest+json", ".json": "application/json; charset=utf-8", ".map": "application/json",
    ".woff2": "font/woff2", ".webp": "image/webp",
}
HASHED = re.compile(r"-[0-9a-f]{8}\.[a-z0-9]+$")  # app-1a2b3c4d.js: the build names assets by content
_state_lock = threading.Lock()


class Refused(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status, self.message = status, message


def resolve(rel: str) -> Path | None:
    """The file `rel` names inside WEB_DIR, or None for anything else: outside it (.., encoded dots, symlinks),
    a directory, one of the server's own files, or a name that cannot be a path."""
    rel = unquote(rel).lstrip("/") or "index.html"
    if "\x00" in rel or "\\" in rel:
        return None
    root = WEB_DIR.resolve()
    try:
        found = (root / rel).resolve()
    except (OSError, ValueError):
        return None
    if not found.is_relative_to(root) or not found.is_file():
        return None
    if found.parent == root and found.name in PRIVATE:
        return None
    return found


def serve(handler, route: str) -> None:
    """Answers GET /app[/path] on `handler` (an http_api.Handler)."""
    if route == "/app":  # relative URLs in index.html only resolve under /app/
        handler.send_response(308)
        handler.send_header("Location", "/app/")
        handler.send_header("Content-Length", "0")
        handler.end_headers()
        return
    rel = route[len("/app/"):]
    found = resolve("login.html" if rel == "login" else rel)
    if found is None:
        return handler._send(404, {"error": "not found"})
    data = found.read_bytes()
    handler.send_response(200)
    handler.send_header("Content-Type", TYPES.get(found.suffix.lower(), "application/octet-stream"))
    handler.send_header("Content-Length", str(len(data)))
    handler.send_header("Cache-Control", "max-age=31536000, immutable" if HASHED.search(found.name) else "no-cache")
    handler.send_header("X-Content-Type-Options", "nosniff")
    handler.end_headers()
    handler.wfile.write(data)


def _empty() -> dict:
    return {"prefs": {}, "files": {}}


def read_state() -> dict:
    try:
        state = json.loads((WEB_DIR / STATE_NAME).read_text())
    except (OSError, ValueError):
        return _empty()
    if not isinstance(state, dict) or not isinstance(state.get("prefs"), dict) or not isinstance(state.get("files"), dict):
        return _empty()
    return {"prefs": state["prefs"], "files": {k: v for k, v in state["files"].items() if isinstance(v, str)}}


def _size(text: str) -> int:
    return len(text.encode())


def update_state(body: object) -> dict:
    """Merges a POST /web/state body into the saved state and returns the result. Raises Refused(400 or 413)."""
    if not isinstance(body, dict):
        raise Refused(400, "expected a JSON object")
    prefs, files = body.get("prefs", {}), body.get("files", {})
    if not isinstance(prefs, dict) or not isinstance(files, dict):
        raise Refused(400, "prefs and files must be objects")
    for name, text in files.items():
        if text is not None and not isinstance(text, str):
            raise Refused(400, f"file {name!r} must be a string")
        if isinstance(text, str) and _size(text) > MAX_FILE_BYTES:
            raise Refused(413, f"file {name!r} is over {MAX_FILE_BYTES // 1024} KB")
    with _state_lock:
        state = read_state()
        for key, value in prefs.items():
            if value is None:
                state["prefs"].pop(key, None)
            else:
                state["prefs"][key] = value
        for name, text in files.items():
            if text is None:
                state["files"].pop(name, None)
            else:
                state["files"][name] = text
        if sum(_size(t) for t in state["files"].values()) > MAX_FILES_BYTES:
            raise Refused(413, f"files are over {MAX_FILES_BYTES // (1024 * 1024)} MB in total")
        if _size(json.dumps(state["prefs"])) > MAX_PREFS_BYTES:
            raise Refused(413, f"prefs are over {MAX_PREFS_BYTES // 1024} KB")
        WEB_DIR.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=WEB_DIR, prefix=".state-", suffix=".tmp")
        try:
            with os.fdopen(fd, "w") as f:
                json.dump(state, f, ensure_ascii=False)
            os.replace(tmp, WEB_DIR / STATE_NAME)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise
        return state


TAILSCALE = (shutil.which("tailscale"), "/Applications/Tailscale.app/Contents/MacOS/Tailscale")


def _tailscale(*args: str) -> dict | None:
    for binary in TAILSCALE:
        if not binary or not os.access(binary, os.X_OK):
            continue
        try:
            done = subprocess.run([binary, *args, "--json"], capture_output=True, text=True, timeout=5)
            return json.loads(done.stdout) if done.returncode == 0 else None
        except (OSError, ValueError, subprocess.SubprocessError):
            continue
    return None


def phone_link(api_token: str, port: int = 27182) -> dict:
    """What Settings shows under "Use on your phone": {"url", "host"} when the Mac is reachable over a tailnet and
    `tailscale serve` forwards to this server, else {"problem", "command"?} in plain words. Runs `tailscale status`
    and `tailscale serve status`, never `tailscale serve` itself."""
    status = _tailscale("status")
    if status is None:
        return {"problem": "Tailscale is not installed or not running on this Mac. Install it from tailscale.com, sign in on the Mac and the phone, then reopen Settings."}
    dns = str((status.get("Self") or {}).get("DNSName", "")).rstrip(".")
    if status.get("BackendState") != "Running" or not dns:
        return {"problem": "Tailscale is installed but not connected. Turn it on in the menu bar, then reopen Settings."}
    serve = _tailscale("serve", "status") or {}
    target = re.compile(rf"^https?://(127\.0\.0\.1|localhost):{port}/?$")
    found = []
    for key, entry in (serve.get("Web") or {}).items():
        host, _, hport = key.rpartition(":")
        if any(target.match(str(h.get("Proxy", ""))) for h in (entry.get("Handlers") or {}).values()):
            https = bool((serve.get("TCP") or {}).get(hport, {}).get("HTTPS"))
            found.append((not https, f"{'https' if https else 'http'}://{host}{'' if https and hport == '443' else ':' + hport}"))
    if not found:
        return {"problem": "Tailscale is running, but it does not forward to Second Brain yet. Run this once in Terminal:",
                "command": f"tailscale serve --bg --https=8443 http://127.0.0.1:{port}", "host": dns}
    base = min(found)[1]  # an https port first
    app_url = hosted_app_url()
    if app_url:  # the hosted web app (phase 3): it learns this server and the token from the link's #fragment
        return {"url": f"{app_url}#{urlencode({'server': base, 't': api_token})}", "host": dns,
                "secure": base.startswith("https"), "app_url": app_url}
    return {"url": f"{base}/app/login#t={api_token}", "host": dns, "secure": base.startswith("https")}


def hosted_app_url() -> str | None:
    """The hosted web app's address, from VERITAS_WEB_APP_URL or data/web-app-url, else None (use this server's /app/)."""
    url = os.environ.get("VERITAS_WEB_APP_URL", "").strip()
    if not url:
        try:
            url = APP_URL_FILE.read_text(encoding="utf-8").strip()
        except OSError:
            url = ""
    return url or None
