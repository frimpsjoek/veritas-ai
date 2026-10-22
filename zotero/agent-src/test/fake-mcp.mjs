// Two fake MCP servers for mcp-hub.test.js, as a platform.d.ts-shaped spawn (stdio) and fetch (streamable HTTP):
// real processes/servers, not scripted stand-ins, so the JSON-RPC framing and the read loop are actually
// exercised, the same reasoning test/support/spawn-fake-codex.mjs gives for the provider fakes.
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const FAKE_MCP_SERVER = fileURLToPath(new URL('./fake-mcp-server.mjs', import.meta.url));

/** A platform.spawn that ignores the spec and always launches the fake MCP stdio server with the given tools. */
export function fakeMcpSpawn(tools) {
  return async () => {
    const child = spawn(process.execPath, [FAKE_MCP_SERVER], { env: { ...process.env, FAKE_MCP_TOOLS: JSON.stringify(tools) } });
    let stderrTail = '';
    child.stderr.on('data', (chunk) => { stderrTail = (stderrTail + chunk.toString()).slice(-4000); });
    return {
      lines() {
        const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
        return { [Symbol.asyncIterator]: () => rl[Symbol.asyncIterator]() };
      },
      async write(line) { if (child.stdin.writable) child.stdin.write(line + '\n'); },
      stderrTail() { return stderrTail; },
      async kill() { if (!child.killed) child.kill(); },
      exited: new Promise((resolve) => child.on('exit', (code) => resolve(code ?? 0))),
    };
  };
}

/** A real loopback HTTP server speaking the streamable-HTTP MCP shape (one JSON-RPC response per POST). Returns
 *  { fetch, url, close }; `fetch` is a real fetch bound to that one origin, so it also proves the client's
 *  header/body framing against a real socket, not just an in-memory stand-in. */
export async function startFakeMcpHttp(tools, { failInit = false, sessions = false, sse = false } = {}) {
  // sessions: true behaves like Hugging Face: initialize issues `mcp-session-id`, every other request must carry a
  // live one (400 "Session ID required" when absent, 404 when unknown), and the notification is answered 202 empty.
  const live = new Set();
  const stats = { initializes: 0, versions: [], forget() { live.clear(); } };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      res.setHeader('content-type', sse ? 'text/event-stream' : 'application/json');
      if (sse) { const end = res.end.bind(res); res.end = (data) => end(data && !data.startsWith('event') ? `event: message\ndata: ${data}\n\n` : data); }
      if (sessions && body.method !== 'initialize') {
        const sid = req.headers['mcp-session-id'];
        if (!sid) { res.writeHead(400); res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Session ID required' } })); return; }
        if (!live.has(sid)) { res.writeHead(404); res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' } })); return; }
      }
      if (body.method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
      if (body.method === 'initialize' && failInit) { res.writeHead(500); res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message: 'boom' } })); return; }
      if (body.method === 'initialize') {
        stats.initializes += 1;
        stats.versions.push(body.params?.protocolVersion);
        if (sessions) { const sid = `sess-${stats.initializes}`; live.add(sid); res.setHeader('mcp-session-id', sid); }
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: sessions ? body.params?.protocolVersion : '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake-http-mcp', version: '0' } } }));
        return;
      }
      if (body.method === 'tools/list') {
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: tools.map(({ name, description, annotations, inputSchema }) => ({ name, description, annotations, inputSchema: inputSchema ?? { type: 'object', properties: {} } })) } }));
        return;
      }
      if (body.method === 'tools/call') {
        const tool = tools.find((t) => t.name === body.params?.name);
        const result = tool ? (tool.result ?? { content: [{ type: 'text', text: `ran ${tool.name}` }] }) : { content: [], isError: true };
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
        return;
      }
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: `Unknown method: ${body.method}` } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    stats,
    async close() { await new Promise((resolve) => server.close(resolve)); },
  };
}
