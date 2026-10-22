"""Stub update server for update-e2e.sh: serves /plugins/obsidian/* from a temp dist root using the real
plugin_updates logic. Usage: stub.py <kb-dir> <zotero-dist> <obsidian-dist> <port>"""
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

kb, zdist, odist, port = sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3]), int(sys.argv[4])
sys.path.insert(0, kb)
import plugin_updates as pu


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(self.path, flush=True)

    def do_GET(self):
        url = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        if url.path == "/plugins/obsidian/latest":
            body = json.dumps(pu.latest_obsidian(zdist, odist)).encode()
        elif url.path == "/plugins/obsidian/file":
            found = pu.obsidian_file_path(zdist, odist, q.get("version", ""), q.get("name", ""))
            if not found:
                self.send_response(404); self.end_headers(); return
            body = found.read_bytes()
        else:
            self.send_response(404); self.end_headers(); return
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


HTTPServer(("127.0.0.1", port), Handler).serve_forever()
