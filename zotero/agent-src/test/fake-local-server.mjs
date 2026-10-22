// A FAKE OpenAI-compatible HTTP server for the local-model tests (spec 010): a real node:http listener on a free
// loopback port, streaming server-sent events like mlx_lm.server / Ollama / LM Studio do. It records every request body.
import http from 'node:http';

/**
 * @param {{ models?: string[] }} [opts]
 * Script the next completion with `server.next({ pieces, finish })` (pieces are content deltas),
 * `server.next({ repeat: 'line\n' })` (the same text forever) or `server.next({ endless: (i) => text })`
 * (a never-ending stream of different text); both run until the client disconnects.
 */
export async function startFakeServer({ models = ['fake-model'] } = {}) {
  const requests = [];
  const queue = [];
  const state = { clientClosed: 0, sent: 0 };
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url?.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: models.map((id) => ({ id, object: 'model' })) }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const body = JSON.parse(raw);
        requests.push(body);
        const script = queue.shift() ?? { pieces: ['ok'] };
        if (script.status) { res.writeHead(script.status, { 'content-type': 'text/plain' }); res.end(script.text ?? 'error'); return; }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.on('close', () => { if (!res.writableEnded) state.clientClosed += 1; });
        const send = (obj) => { state.sent += 1; res.write(`data: ${JSON.stringify(obj)}\n\n`); };
        if (script.repeat || script.endless) {
          let i = 0;
          const timer = setInterval(() => {
            if (res.destroyed || res.writableEnded) { clearInterval(timer); return; }
            i += 1;
            send({ choices: [{ delta: { content: script.endless ? script.endless(i) : script.repeat } }] });
          }, 1);
          res.on('close', () => clearInterval(timer));
          return;
        }
        for (const piece of script.pieces ?? []) send({ choices: [{ delta: { content: piece } }] });
        send({ choices: [{ delta: {}, finish_reason: script.finish ?? 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 12 } });
        res.end('data: [DONE]\n\n');
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    port, baseUrl: `http://127.0.0.1:${port}/v1`, requests, state,
    next(script) { queue.push(script); },
    async close() { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); },
  };
}
