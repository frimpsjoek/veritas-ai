// agent-src/src/node/platform.mjs. The Node implementation of platform.d.ts's Platform port: child_process.spawn,
// fs/promises, the global fetch, and one shared http.createServer that routes are mounted on and off of. This is
// what the sidecar (agentd, T3.1) runs on; Zotero gets gecko/platform.js (T4.1) against the same interface.
import { spawn as nodeSpawn } from 'node:child_process';
import { promises as fsp, constants as fsConstants } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import readline from 'node:readline';
import { randomBytes } from 'node:crypto';
import { errorMessage, errorField } from '../errors.js';

function wrapChild(child) {
  let stderrTail = '';
  child.stderr?.on('data', (chunk) => { stderrTail = (stderrTail + chunk.toString()).slice(-4000); });
  // A process that died while we were still writing to it (EPIPE) is not an error of ours: the reader sees the
  // closed stdout and reports the crash. Unhandled, the 'error' event would take the whole sidecar down.
  child.stdin?.on('error', () => {});
  // A command that could not start (ENOENT: not on PATH, as under launchd) emits only 'error', never 'exit'.
  // Unhandled it takes the whole sidecar down; here it reads like any child that died at once.
  const exited = new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    child.on('error', (error) => {
      stderrTail = (stderrTail + `${error.message}\n`).slice(-4000);
      if (child.pid === undefined) resolve(127);
    });
  });
  return {
    pid: child.pid,
    lines() {
      const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      return { [Symbol.asyncIterator]: () => rl[Symbol.asyncIterator]() };
    },
    async write(line) {
      if (child.stdin?.writable) child.stdin.write(`${line}\n`);
    },
    async closeInput() {
      if (child.stdin?.writable) child.stdin.end();
    },
    stderrTail() { return stderrTail; },
    async kill() {
      if (!child.killed) child.kill();
    },
    exited,
  };
}

async function exists(filePath) {
  try { await fsp.access(filePath, fsConstants.F_OK); return true; } catch { return false; }
}

/** @returns {import("../platform").Platform} */
export function createNodePlatform({ homeDir = process.env.HOME ?? '' } = {}) {
  let server = null;
  let serverPort = null;
  const routes = new Map();

  async function ensureServer() {
    if (server) return;
    server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        const routePath = (req.url ?? '/').split('?')[0];
        const handler = routes.get(routePath);
        if (!handler) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'not found' })); return; }
        const headers = {};
        for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(',') : v ?? '';
        try {
          const out = await handler({ headers, body: Buffer.concat(chunks).toString('utf8') });
          res.writeHead(out.status, { 'content-type': 'application/json' });
          res.end(out.body);
        } catch (error) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: errorMessage(error) }));
        }
      });
    });
    const listening = server;
    await new Promise((resolve) => listening.listen(0, '127.0.0.1', () => resolve(undefined)));
    listening.unref(); // a test or a short-lived script (dev/ask.mjs) shouldn't hang on this alone
    const address = listening.address(); // an AddressInfo once a TCP listen has succeeded; a string only for pipes
    if (!address || typeof address === 'string') throw new Error('the local server did not get a TCP port');
    serverPort = address.port;
  }

  return {
    async spawn(spec) {
      const child = nodeSpawn(spec.cmd, spec.args, { cwd: spec.cwd, env: { ...process.env, ...spec.env } });
      return wrapChild(child);
    },

    async which(candidates) {
      for (const candidate of candidates) {
        if (!candidate) continue;
        if (candidate.includes(path.sep) || candidate.startsWith('/')) {
          if (await exists(candidate)) return candidate;
          continue;
        }
        for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
          const full = path.join(dir, candidate);
          if (await exists(full)) return full;
        }
      }
      return null;
    },

    fetch,

    fs: {
      async read(filePath) {
        try { return await fsp.readFile(filePath, 'utf8'); }
        catch (error) { if (errorField(error, 'code') === 'ENOENT') return null; throw error; }
      },
      async writeAtomic(filePath, text, opts = {}) {
        await fsp.mkdir(path.dirname(filePath), { recursive: true });
        const tmp = `${filePath}.tmp-${randomBytes(4).toString('hex')}`;
        // `private`: the temp file is created owner-only, so the key is never readable by others, not even for a moment
        await fsp.writeFile(tmp, text, opts.private ? { encoding: 'utf8', mode: 0o600 } : 'utf8');
        if (opts.private) await fsp.chmod(tmp, 0o600);  // the umask cannot widen it, but an existing tmp name could
        await fsp.rename(tmp, filePath);
      },
      async append(filePath, line) {
        await fsp.mkdir(path.dirname(filePath), { recursive: true });
        await fsp.appendFile(filePath, `${line}\n`, 'utf8');
      },
      async list(dir) {
        try { return await fsp.readdir(dir); }
        catch (error) { if (errorField(error, 'code') === 'ENOENT') return []; throw error; }
      },
      async stat(filePath) {
        try { const st = await fsp.stat(filePath); return { size: st.size, dir: st.isDirectory() }; }
        catch (error) { if (errorField(error, 'code') === 'ENOENT' || errorField(error, 'code') === 'ENOTDIR') return null; throw error; }
      },
      async remove(filePath) {
        try { await fsp.unlink(filePath); }
        catch (error) { if (errorField(error, 'code') !== 'ENOENT') throw error; }
      },
      async removeTree(dirPath) { await fsp.rm(dirPath, { recursive: true, force: true }); },
      async symlink(target, filePath) {
        await fsp.mkdir(path.dirname(filePath), { recursive: true });
        try { await fsp.symlink(target, filePath); }
        catch (error) { if (errorField(error, 'code') !== 'EEXIST') throw error; }
      },
    },

    async serve(routePath, handler) {
      await ensureServer();
      routes.set(routePath, handler);
      return {
        url: `http://127.0.0.1:${serverPort}${routePath}`,
        unmount() { routes.delete(routePath); },
      };
    },

    homeDir,
  };
}
