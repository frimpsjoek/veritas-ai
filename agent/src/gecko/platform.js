// @ts-check
// agent-src/src/gecko/platform.js. The Zotero (Gecko) implementation of platform.d.ts's Platform port:
// Subprocess.sys.mjs for spawn, IOUtils/PathUtils for files, the chrome fetch, and one Zotero.Server endpoint per
// mounted route on Zotero's own HTTP server (23119 by default). Every Gecko global arrives through `deps`, so the
// same code runs under node:test against fakes.
import { errorMessage, errorField } from '../errors.js';

const STDERR_TAIL = 4000;

/**
 * @typedef {{
 *   Subprocess: any, IOUtils: any, PathUtils: any, Zotero: any,
 *   fetch: typeof fetch, env: (name: string) => string | undefined, homeDir: string, isWindows?: boolean,
 * }} GeckoDeps
 */

/** Newline-delimited lines from a Subprocess pipe. Chunks break anywhere, so a partial line waits for the rest. */
async function* pipeLines(pipe) {
  let buffer = '';
  for (;;) {
    let chunk;
    try { chunk = await pipe.readString(); } catch { break; } // the pipe closes when the process dies
    if (!chunk) break;
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      yield buffer.slice(0, at).replace(/\r$/, '');
      buffer = buffer.slice(at + 1);
    }
  }
  if (buffer) yield buffer;
}

function wrapProcess(proc) {
  let stderrTail = '';
  (async () => {
    for (;;) {
      let chunk;
      try { chunk = await proc.stderr.readString(); } catch { return; }
      if (!chunk) return;
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL);
    }
  })();
  let lines = null;
  let killed = false;
  return {
    pid: typeof proc.pid === 'number' ? proc.pid : undefined,
    lines() {
      // Subprocess pipes allow one reader; a second caller shares the first iterator rather than racing it.
      lines ??= pipeLines(proc.stdout);
      return lines;
    },
    async write(line) {
      if (!killed) await proc.stdin.write(`${line}\n`);
    },
    async closeInput() {
      if (!killed) { try { await proc.stdin.close(); } catch { /* already closed */ } }
    },
    stderrTail() { return stderrTail; },
    async kill() {
      if (killed) return;
      killed = true;
      try { await proc.stdin.close(); } catch { /* already closed */ }
      await proc.kill();
    },
    exited: proc.wait().then((result) => result?.exitCode ?? 0),
  };
}

function plainHeaders(headers) {
  if (!headers) return {};
  const out = {};
  const entries = typeof headers.entries === 'function' ? headers.entries() : Object.entries(headers);
  for (const [key, value] of entries) out[String(key).toLowerCase()] = String(value);
  return out;
}

/**
 * @param {GeckoDeps} deps
 * @returns {import("../platform").Platform}
 */
export function createGeckoPlatform(deps) {
  const { Subprocess, IOUtils, PathUtils, Zotero } = deps;
  const delimiter = deps.isWindows ? ';' : ':';
  // Zotero starts from the Dock with a minimal PATH, so the usual install places are searched as well.
  const extraDirs = deps.isWindows ? [] : [`${deps.homeDir}/.local/bin`, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];

  async function isFile(path) {
    try { return await IOUtils.exists(path); } catch { return false; }
  }

  async function ensureParent(path) {
    await IOUtils.makeDirectory(PathUtils.parent(path), { createAncestors: true, ignoreExisting: true });
  }

  const platform = {
    async spawn(spec) {
      const proc = await Subprocess.call({
        command: spec.cmd,
        arguments: spec.args,
        environment: spec.env,
        environmentAppend: true,
        workdir: spec.cwd,
        stderr: 'pipe',
      });
      return wrapProcess(proc);
    },

    async which(candidates) {
      const dirs = [...(deps.env('PATH') ?? '').split(delimiter).filter(Boolean), ...extraDirs];
      for (const candidate of candidates) {
        if (!candidate) continue;
        if (PathUtils.isAbsolute?.(candidate) ?? candidate.startsWith('/')) {
          if (await isFile(candidate)) return candidate;
          continue;
        }
        for (const dir of dirs) {
          const full = PathUtils.join(dir, candidate);
          if (await isFile(full)) return full;
        }
      }
      return null;
    },

    fetch: deps.fetch,

    fs: {
      async read(path) {
        try { return await IOUtils.readUTF8(path); }
        catch (error) { if (errorField(error, 'name') === 'NotFoundError') return null; throw error; }
      },
      async writeAtomic(path, text, opts = {}) {
        await ensureParent(path);
        await IOUtils.writeUTF8(path, text, { tmpPath: `${path}.tmp` });
        if (opts.private) await IOUtils.setPermissions(path, 0o600);
      },
      async append(path, line) {
        await ensureParent(path);
        await IOUtils.writeUTF8(path, `${line}\n`, { mode: 'appendOrCreate' });
      },
      async list(dir) {
        try { return (await IOUtils.getChildren(dir)).map((child) => PathUtils.filename(child)); }
        catch (error) { if (errorField(error, 'name') === 'NotFoundError') return []; throw error; }
      },
      async stat(path) {
        try { const st = await IOUtils.stat(path); return { size: Number(st.size ?? 0), dir: st.type === 'directory' }; }
        catch (error) { if (errorField(error, 'name') === 'NotFoundError') return null; throw error; }
      },
      async remove(path) {
        await IOUtils.remove(path, { ignoreAbsent: true });
      },
      async removeTree(path) { await IOUtils.remove(path, { recursive: true, ignoreAbsent: true }); },
      async symlink(target, path) {
        await ensureParent(path);
        // IOUtils has no symlink; Windows gets a copy, which loses token refreshes but still signs in.
        if (deps.isWindows) { await IOUtils.copy(target, path, { noOverwrite: true }); return; }
        const ln = await Subprocess.call({ command: '/bin/ln', arguments: ['-s', target, path], stderr: 'pipe' });
        const { exitCode } = await ln.wait();
        if (exitCode !== 0) throw new Error(`could not link ${path}`);
      },
    },

    async serve(path, handler) {
      const Endpoint = function () {};
      Endpoint.prototype = {
        supportedMethods: ['POST'],
        supportedDataTypes: ['application/json'],
        permitBookmarklet: false,
        async init(req) {
          // Zotero.Server has already parsed an application/json body; the handler takes the raw text.
          const body = typeof req.data === 'string' ? req.data : JSON.stringify(req.data ?? null);
          try {
            const out = await handler({ headers: plainHeaders(req.headers), body });
            return [out.status, 'application/json', out.body];
          } catch (error) {
            return [500, 'application/json', JSON.stringify({ error: errorMessage(error) })];
          }
        },
      };
      Zotero.Server.Endpoints[path] = Endpoint;
      const port = Zotero.Prefs.get('httpServer.port') || 23119;
      return {
        url: `http://127.0.0.1:${port}${path}`,
        unmount() { if (Zotero.Server.Endpoints[path] === Endpoint) delete Zotero.Server.Endpoints[path]; },
      };
    },

    homeDir: deps.homeDir,
  };
  return platform;
}
