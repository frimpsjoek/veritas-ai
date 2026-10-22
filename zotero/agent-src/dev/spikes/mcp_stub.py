"""Minimal streamable-HTTP MCP server (JSON responses, no SSE), one tool. Logs calls to calls.log."""
import json, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOOL = {
    "name": "search_library",
    "description": "Search the user's research library. Always use this for questions about the library.",
    "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]},
    "annotations": {"readOnlyHint": True},
}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        msg = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        with open("calls.log", "a") as f:
            f.write(json.dumps(msg) + "\n")
        if "id" not in msg:
            self.send_response(202); self.end_headers(); return
        m, r = msg["method"], None
        if m == "initialize":
            r = {"protocolVersion": msg["params"].get("protocolVersion", "2025-06-18"),
                 "capabilities": {"tools": {}}, "serverInfo": {"name": "stub", "version": "0"}}
        elif m == "tools/list":
            r = {"tools": [TOOL]}
        elif m == "tools/call":
            q = msg["params"]["arguments"].get("query", "")
            r = {"content": [{"type": "text", "text": f"RESULT-MARKER-7731: 1 paper found for '{q}': Smith 2021 [@smith2021]"}]}
        else:
            r = {}
        body = json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": r}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.send_response(405); self.end_headers()


ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
