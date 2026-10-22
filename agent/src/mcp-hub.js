// @ts-check
// agent-src/src/mcp-hub.js (T6.1). A small MCP client: stdio through platform.spawn (the same newline-delimited
// JSON-RPC ChildProcess every provider already speaks) and streamable HTTP through fetch. One verdict function
// decides what a connected server's tools become in our own gateway: readOnlyHint:true is exposed;
// destructiveHint:true or readOnlyHint:false is hidden ("can change things"); no hint at all is hidden ("doesn't
// say whether it changes things") until the user turns on "Trust this server" for that one config. Exposed
// tools are re-exported as namespaced ToolRow entries ("<server>__<tool>"), always stamped readOnlyHint:true —
// tools.js merges these into the same registry the built-in rows live in, so Codex, Claude and the in-process
// OpenAI-compatible loop all see one gateway, never a user's raw MCP config.
import { errorMessage } from './errors.js';

const READ_ONLY = Object.freeze({ readOnlyHint: true });
const RPC_TIMEOUT_MS = 15_000;

/** @param {{ annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }} tool
 *  @param {boolean} trustUnmarked
 *  @returns {import("./tools").McpToolVerdict} */
export function verdictFor(tool, trustUnmarked) {
  const a = tool.annotations ?? {};
  if (a.readOnlyHint === true) return 'exposed';
  if (a.destructiveHint === true || a.readOnlyHint === false) return 'hidden_writes';
  return trustUnmarked ? 'exposed' : 'hidden_unmarked';
}

/** The reason text the Settings UI shows next to a hidden tool (T6.3). Not part of the wire contract
 *  (tools.d.ts's McpServerReport.tools has no reason field), so it's a pure function of the verdict instead. */
export function reasonForVerdict(verdict) {
  if (verdict === 'hidden_writes') return 'marks itself as able to change things';
  if (verdict === 'hidden_unmarked') return "doesn't say whether it changes things";
  return null;
}

function jsonRpcRequest(id, method, params) {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params });
}

/** @param {(spec: import("./platform").SpawnSpec) => Promise<import("./platform").ChildProcess>} spawn
 *  @param {{ command: string; args: string[]; env: Record<string,string> }} config */
function createStdioClient(spawn, config) {
  /** @type {import("./platform").ChildProcess | null} */
  let child = null;
  let nextId = 1;
  const pending = new Map();

  async function ensure() {
    if (child) return child;
    const proc = await spawn({ cmd: config.command, args: config.args ?? [], env: { ...(config.env ?? {}) }, cwd: '' });
    child = proc;
    (async () => {
      try {
        for await (const line of proc.lines()) {
          let msg;
          try { msg = JSON.parse(line); } catch { continue; } // a server's own stray stdout line, not JSON-RPC
          if (msg && msg.id != null && pending.has(msg.id)) {
            const { resolve, timer } = pending.get(msg.id);
            clearTimeout(timer); // otherwise this keeps the process (and node --test's file-level subprocess) alive for up to RPC_TIMEOUT_MS after every call
            pending.delete(msg.id);
            resolve(msg);
          }
        }
      } catch { /* the read loop ends when the process exits; callers waiting on a reply get the timeout instead */ }
    })();
    return proc;
  }

  async function call(method, params) {
    const proc = await ensure();
    const id = nextId++;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`${config.command}: no response to "${method}"`));
      }, RPC_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
    });
    await proc.write(jsonRpcRequest(id, method, params));
    const msg = await result;
    if (msg.error) throw new Error(msg.error.message ?? `MCP error from ${config.command}`);
    return msg.result;
  }

  return {
    async connect() { await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'second-brain', version: '0' } }); },
    async listTools() { return (await call('tools/list', {})).tools ?? []; },
    async callTool(name, args) { return call('tools/call', { name, arguments: args ?? {} }); },
    async close() {
      const c = child;
      child = null;
      for (const [id, { reject, timer }] of pending) { clearTimeout(timer); reject(new Error('MCP server closed')); pending.delete(id); }
      if (c) await c.kill().catch(() => {});
    },
  };
}

/** Parses either a plain JSON-RPC response body or a one-shot `text/event-stream` body (the streamable-HTTP
 *  transport's non-streaming case): the last `data:` line is the JSON-RPC message. */
function parseRpcBody(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  let last = null;
  for (const line of trimmed.split('\n')) {
    if (line.startsWith('data:')) { try { last = JSON.parse(line.slice(5).trim()); } catch { /* ignore a stray keepalive line */ } }
  }
  if (!last) throw new Error('Empty response from MCP server');
  return last;
}

const HTTP_PROTOCOL_VERSION = '2025-03-26';

/** A server that dropped or never got our session answers 404, or 400 with "Session ID required"-style text. */
const sessionGone = (/** @type {number} */ status, /** @type {string} */ text) => status === 404 || (status === 400 && /session/i.test(text));

/** Streamable HTTP: initialize, keep the `mcp-session-id` it hands back, announce `notifications/initialized`, and
 *  start over once when the server forgets the session. Servers that never issue a session id work unchanged.
 *  @param {typeof fetch} fetchFn @param {{ url: string; headers: Record<string,string> }} config */
function createHttpClient(fetchFn, config) {
  let nextId = 1;
  /** @type {string | null} */
  let sessionId = null;
  /** @type {string | null} */
  let protocolVersion = null;

  async function post(body) {
    return fetchFn(config.url, {
      method: 'POST',
      // "connection: close" so a one-shot JSON-RPC call never leaves an idle keep-alive socket in fetch's
      // connection pool: an unclosed one is what kept node --test's own process alive well past every test in
      // this file finishing (found live, not a hypothesis: this is the actual fix, verified by the hang going away).
      headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream', connection: 'close',
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
        ...(protocolVersion ? { 'mcp-protocol-version': protocolVersion } : {}),
        ...(config.headers ?? {}),
      },
      body,
    });
  }

  async function handshake() {
    sessionId = null;
    protocolVersion = null;
    const res = await post(jsonRpcRequest(nextId++, 'initialize', { protocolVersion: HTTP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'second-brain', version: '0' } }));
    const text = await res.text();
    if (!res.ok) throw new Error(`${config.url} returned ${res.status}`);
    const msg = parseRpcBody(text);
    if (msg.error) throw new Error(msg.error.message ?? `MCP error from ${config.url}`);
    sessionId = res.headers.get('mcp-session-id');
    protocolVersion = msg.result?.protocolVersion ?? null;
    try { await (await post(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))).text(); } catch { /* a server that rejects the notification fails the next request with its own message */ }
  }

  async function call(method, params, retried = false) {
    const res = await post(jsonRpcRequest(nextId++, method, params));
    const text = await res.text();
    if (!res.ok) {
      if (!retried && sessionGone(res.status, text)) { await handshake(); return call(method, params, true); }
      throw new Error(`${config.url} returned ${res.status}`);
    }
    const msg = parseRpcBody(text);
    if (msg.error) throw new Error(msg.error.message ?? `MCP error from ${config.url}`);
    return msg.result;
  }
  return {
    connect: handshake,
    async listTools() { return (await call('tools/list', {})).tools ?? []; },
    async callTool(name, args) { return call('tools/call', { name, arguments: args ?? {} }); },
    async close() {},
  };
}

function clientFor(platform, config) {
  return config.transport === 'stdio'
    ? createStdioClient((spec) => platform.spawn(spec), config)
    : createHttpClient(platform.fetch, config);
}

function toolText(result) {
  if (!result) return '';
  const parts = (result.content ?? []).map((c) => (c.type === 'text' ? c.text : c.text ?? JSON.stringify(c)));
  const text = parts.filter(Boolean).join('\n');
  if (text) return text;
  return result.isError ? 'The tool reported an error with no message.' : '';
}

/**
 * @param {{ fetch: typeof fetch, spawn: import("./platform").Platform["spawn"] }} platform
 * @param {{ initial?: (import("./tools").McpServerConfig & { trustUnmarked?: boolean })[] }} [opts]
 * @returns {import("./tools").McpHub & { ready: Promise<void> }}
 */
export function createMcpHub(platform, opts = {}) {
  /** @type {Map<string, { config: any, client: any, state: "connected"|"failed"|"disabled", error: string|null, tools: any[] }>} */
  const servers = new Map();

  async function connect(entry) {
    const { config } = entry;
    await entry.client?.close?.().catch(() => {});
    entry.client = null;
    if (!config.enabled) { entry.state = 'disabled'; entry.error = null; entry.tools = []; return; }
    try {
      const client = clientFor(platform, config);
      await client.connect();
      const rawTools = await client.listTools();
      entry.client = client;
      entry.state = 'connected';
      entry.error = null;
      entry.tools = rawTools.map((raw) => ({ name: raw.name, description: raw.description ?? '', verdict: verdictFor(raw, !!config.trustUnmarked), raw }));
    } catch (error) {
      entry.state = 'failed';
      entry.error = errorMessage(error); // a plain message; never breaks a turn, this is Test/startup only
      entry.tools = [];
    }
  }

  function toReport(entry) {
    return { config: entry.config, state: entry.state, error: entry.error, tools: entry.tools.map(({ name, description, verdict }) => ({ name, description, verdict })) };
  }

  async function save(config) {
    // The real bug this guards against: `save()` used to build a fresh `entry` and drop whatever was already in
    // `servers` for this name straight on the floor, client and all -- so re-saving a config (the Settings UI's
    // own "Trust this server" switch calls save() again) silently orphaned the old client's spawned process,
    // never killed. Closing it first is what makes every save() -> save() sequence leave exactly one live child.
    await servers.get(config.name)?.client?.close?.().catch(() => {});
    const entry = { config, client: null, state: /** @type {const} */ ('disabled'), error: null, tools: [] };
    servers.set(config.name, entry);
    await connect(entry);
    return toReport(entry);
  }

  async function remove(name) {
    const entry = servers.get(name);
    if (!entry) return;
    await entry.client?.close?.().catch(() => {});
    servers.delete(name);
  }

  function rows() {
    /** @type {import("./tools").ToolRow[]} */
    const out = [];
    for (const [name, entry] of servers) {
      if (entry.state !== 'connected') continue;
      for (const tool of entry.tools) {
        if (tool.verdict !== 'exposed') continue;
        out.push({
          name: `${name}__${tool.name}`,
          description: tool.description,
          inputSchema: tool.raw.inputSchema ?? { type: 'object', properties: {} },
          annotations: READ_ONLY,
          activity: { kind: 'mcp', label: () => `Using ${name}: ${tool.name}` },
          // a server with its own source switch (valency) is offered only while that switch is on
          enabled: (ctx) => /** @type {any} */ (ctx?.sources)?.[name] !== false,
          async run(args) {
            const result = await entry.client.callTool(tool.name, args ?? {});
            return { text: toolText(result), seen: [] };
          },
        });
      }
    }
    return out;
  }

  const ready = Promise.all((opts.initial ?? []).map((config) => save(config))).then(() => undefined);

  return {
    ready,
    async reports() { await ready; return [...servers.values()].map(toReport); },
    async save(config) { await ready; return save(config); },
    async remove(name) { await ready; return remove(name); },
    rows,
    /** Calls one tool of a connected server directly (the radar's MCP source). Throws a plain message when it cannot. */
    async call(server, tool, args) {
      await ready;
      const entry = servers.get(server);
      if (!entry || entry.state !== 'connected') throw new Error(`${server} is not connected`);
      const found = entry.tools.find((t) => t.name === tool);
      if (!found) throw new Error(`${server} has no tool ${tool}`);
      if (found.verdict !== 'exposed') throw new Error(`${server}: ${tool} ${reasonForVerdict(found.verdict)}`);
      return toolText(await entry.client.callTool(tool, args ?? {}));
    },
  };
}
