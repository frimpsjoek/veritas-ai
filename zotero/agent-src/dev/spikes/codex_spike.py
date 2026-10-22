"""Drive `codex app-server`: mode 'dynamic' registers a host tool; mode 'mcp' attaches the HTTP MCP stub."""
import json, subprocess, sys, threading, time

CODEX = "/Applications/ChatGPT.app/Contents/Resources/codex"
mode = sys.argv[1]
PROMPT = "Use the search_library tool to search for 'graphene'. Reply with only the exact text the tool returned."

args = [CODEX, "app-server", "-c", "sandbox_mode=\"read-only\"", "-c", "approval_policy=\"never\""]
if mode == "mcp":
    args += ["-c", 'mcp_servers.stub.url="http://127.0.0.1:8765/mcp"']
p = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=open(f"codex-{mode}.err", "w"), text=True, bufsize=1)
log = open(f"codex-{mode}.jsonl", "w")
nid, done, t0 = [0], threading.Event(), time.time()


def send(method, params, rid=True):
    msg = {"jsonrpc": "2.0", "method": method, "params": params}
    if rid:
        nid[0] += 1; msg["id"] = nid[0]
    p.stdin.write(json.dumps(msg) + "\n"); p.stdin.flush()
    return msg.get("id")


def reply(rid, result):
    p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": rid, "result": result}) + "\n"); p.stdin.flush()


thread_id = [None]


def reader():
    for line in p.stdout:
        log.write(line)
        m = json.loads(line)
        meth = m.get("method")
        if m.get("id") == 2 and "result" in m:
            thread_id[0] = m["result"]["thread"]["id"]
            send("turn/start", {"threadId": thread_id[0], "input": [{"type": "text", "text": PROMPT}]})
        if "error" in m:
            print("ERROR", json.dumps(m)[:600])
        if meth == "item/tool/call":
            print(f"[{time.time()-t0:.1f}s] dynamic tool call:", json.dumps(m["params"])[:300])
            reply(m["id"], {"contentItems": [{"type": "inputText", "text": "RESULT-MARKER-7731: 1 paper found: Smith 2021 [@smith2021]"}], "success": True})
        elif meth and meth.endswith("requestApproval"):
            print("approval request (declining):", meth)
            reply(m["id"], {"decision": "decline"})
        elif meth == "item/completed":
            it = m["params"]["item"]
            print(f"[{time.time()-t0:.1f}s] item:", it["type"], json.dumps(it)[:250])
        elif meth == "turn/completed":
            print(f"[{time.time()-t0:.1f}s] turn completed:", json.dumps(m["params"])[:300]); done.set(); return


threading.Thread(target=reader, daemon=True).start()
send("initialize", {"clientInfo": {"name": "second-brain-spike", "version": "0"}, "capabilities": {"experimentalApi": True}})
send("initialized", {}, rid=False)
params = {"cwd": "/tmp", "ephemeral": True, "sandbox": "read-only", "approvalPolicy": "never"}
if mode == "dynamic":
    params["dynamicTools"] = [{"type": "function", "name": "search_library",
                               "description": "Search the user's research library.",
                               "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}}]
send("thread/start", params)
ok = done.wait(180)
print("finished" if ok else "TIMEOUT")
p.terminate()
