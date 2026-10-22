"""P0.1: private CODEX_HOME isolation + token refresh keeps symlink. P0.2: per-thread config.mcp_servers."""
import json, os, subprocess, sys, threading, time

# A throwaway directory for the private CODEX_HOME this spike creates (first argument, default ./p0-scratch).
SP = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "p0-scratch")
os.makedirs(SP, exist_ok=True)
CODEX = "/Applications/ChatGPT.app/Contents/Resources/codex"
env = dict(os.environ, CODEX_HOME=f"{SP}/codex-home")
p = subprocess.Popen([CODEX, "app-server"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                     stderr=open("p0.err", "w"), text=True, bufsize=1, env=env)
pending, events, nid = {}, [], [0]
lock = threading.Lock()


def call(method, params, timeout=60):
    with lock:
        nid[0] += 1; rid = nid[0]
        ev = threading.Event(); pending[rid] = [ev, None]
        p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params}) + "\n"); p.stdin.flush()
    ev.wait(timeout)
    return pending.pop(rid)[1]


def reader():
    for line in p.stdout:
        m = json.loads(line)
        if "id" in m and m["id"] in pending and "method" not in m:
            pending[m["id"]][1] = m; pending[m["id"]][0].set()
        elif m.get("method", "").endswith("requestApproval"):
            p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": m["id"], "result": {"decision": "decline"}}) + "\n"); p.stdin.flush()
        else:
            events.append(m)


threading.Thread(target=reader, daemon=True).start()
print("init:", json.dumps(call("initialize", {"clientInfo": {"name": "p0", "version": "0"}, "capabilities": {"experimentalApi": True}}))[:150])
p.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "initialized", "params": {}}) + "\n"); p.stdin.flush()

acct = call("account/read", {"refreshToken": True})
print("account/read(refresh):", json.dumps(acct)[:300])
print("symlink still symlink:", os.path.islink(f"{SP}/codex-home/auth.json"))
print("mcp status (should be empty):", json.dumps(call("mcpServerStatus/list", {}))[:300])

if sys.argv[1:] == ["refresh-only"]:
    p.terminate(); sys.exit()

PROMPT = "Call the search_library tool with query 'x'. Reply with only the exact text it returned."
threads = {}
for name, port in (("A", 8771), ("B", 8772)):
    r = call("thread/start", {"cwd": "/tmp", "ephemeral": True, "sandbox": "read-only", "approvalPolicy": "never",
                              "config": {"mcp_servers": {"lib": {"url": f"http://127.0.0.1:{port}/mcp"}}}})
    if "error" in r:
        print("thread/start error", name, r["error"]); continue
    threads[name] = r["result"]["thread"]["id"]
for name, tid in threads.items():
    call("turn/start", {"threadId": tid, "input": [{"type": "text", "text": PROMPT}]})
t0 = time.time()
while time.time() - t0 < 150:
    done = [e for e in events if e.get("method") == "turn/completed"]
    if len(done) >= len(threads): break
    time.sleep(1)
for e in events:
    if e.get("method") == "item/completed" and e["params"]["item"]["type"] in ("agentMessage", "mcpToolCall"):
        tid = e["params"].get("threadId")
        who = [k for k, v in threads.items() if v == tid]
        it = e["params"]["item"]
        print(who, it["type"], it.get("server"), it.get("status"), (it.get("text") or "")[:120])
p.terminate()
