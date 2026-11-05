"""The port opens first. `kb.py serve` binds and answers /ping before kb has looked at a listed folder, since looking may
hang: on 2026-11-03 the desktop app's server sat in opendir at import (a stuck macOS permission prompt for ~/Documents,
most likely), never listened, and was killed with nothing logged. Now the app, the agents and the log can tell a server
that is starting from one that is not there.

Until http_api hands over, /ping says {"ok": true, "ready": false} and any other request waits for the real routes,
then answers 503 "starting". The refusals stay http_api's: only the Mac itself gets the early /ping, everything else
reaches the real Handler or nothing but that 503.

Imports nothing that reads the folder list, or anything heavy (kb imports this first).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Literal, Mapping
from urllib.parse import urlsplit

import web_origins

WAIT_SECONDS = 30  # how long a request waits for the real routes; opening the index usually takes far less
LOCAL_HOSTS = ("127.0.0.1", "localhost")
RequestClass = Literal["foreign", "proxied", "local", "app"]
PROXY_HEADERS = ("x-forwarded-", "tailscale-", "forwarded")


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


class Starting(BaseHTTPRequestHandler):
    """Answers until `ready`. A request that was waiting then continues as the real handler's, already parsed."""

    def _answer(self) -> None:
        early_ping = self.command == "GET" and urlsplit(self.path).path == "/ping" and request_class(self.headers) == "local"
        if early_ping and not self.server.handed_over.is_set():
            return self._send(200, {"ok": True, "ready": False})
        if self.server.handed_over.wait(WAIT_SECONDS):
            self.__class__ = self.server.RequestHandlerClass
            return getattr(self, f"do_{self.command}")()
        self.rfile.read(min(int(self.headers.get("Content-Length") or 0), 1_000_000))  # so the client hears the answer
        self._send(503, {"error": "the server is starting; try again in a moment", "ready": False})

    do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = do_OPTIONS = _answer

    def _send(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args) -> None:  # quiet
        pass


class Listener(ThreadingHTTPServer):
    def __init__(self, port: int) -> None:
        super().__init__(("127.0.0.1", port), Starting)
        self.handed_over = threading.Event()


_listener: Listener | None = None


def stage(text: str) -> None:
    """One line of how far the start got. The app's server.log is this process's stdout and stderr."""
    print(f"{time.strftime('%Y-%m-%d %H:%M:%S')} server: {text}", file=sys.stderr, flush=True)


def listen(port: int) -> Listener:
    """Opens the port and starts answering, once per process (kb.py is imported twice when run as a script)."""
    global _listener
    if _listener is None:
        stage("starting")
        _listener = Listener(port)
        threading.Thread(target=_listener.serve_forever, daemon=True).start()
        stage(f"listening on port {_listener.server_address[1]}")
    return _listener


def ready(server: Listener, handler: type[BaseHTTPRequestHandler]) -> None:
    """From now on every request goes to `handler`, the ones waiting too."""
    server.RequestHandlerClass = handler
    server.handed_over.set()


def if_serving(argv: list[str]) -> None:
    """Called at the very top of kb.py, the one module every entry point starts with."""
    if argv[1:2] != ["serve"]:
        return
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--port", type=int, default=int(os.environ.get("KB_PORT", "27182")))
    listen(parser.parse_known_args(argv[2:])[0].port)
