#!/usr/bin/env node
// A minimal real MCP stdio server for mcp-hub.test.js: reads newline-delimited JSON-RPC on stdin, answers
// initialize/tools/list/tools/call from FAKE_MCP_TOOLS (JSON: [{ name, description, annotations, result }]).
import readline from 'node:readline';

const tools = JSON.parse(process.env.FAKE_MCP_TOOLS ?? '[]');

function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); }
function replyError(id, message) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message } }) + '\n'); }

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  if (req.method === 'initialize') return reply(req.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake-mcp', version: '0' } });
  if (req.method === 'notifications/initialized') return;
  if (req.method === 'tools/list') return reply(req.id, { tools: tools.map(({ name, description, annotations, inputSchema }) => ({ name, description, annotations, inputSchema: inputSchema ?? { type: 'object', properties: {} } })) });
  if (req.method === 'tools/call') {
    const tool = tools.find((t) => t.name === req.params?.name);
    if (!tool) return replyError(req.id, `Unknown tool: ${req.params?.name}`);
    return reply(req.id, tool.result ?? { content: [{ type: 'text', text: `ran ${tool.name}` }] });
  }
  replyError(req.id, `Unknown method: ${req.method}`);
});
