// agent-src/src/node/windows-command.mjs. What spawn() actually starts on Windows (spec 024 TG5).
// Node refuses to start a .cmd or .bat without a shell (EINVAL since Node 18.20/20.12, CVE-2024-27980), and
// `claude`, `codex` and `npx` are installed as exactly such shims. A shell is no answer for us: prompts go on argv,
// and cmd.exe re-reads its command line (quotes, &, |, %VAR%), so a prompt could run commands. Instead the shim is
// resolved to what it runs: npm's shims name `node <script>`, which we start directly; failing that an .exe beside
// the shim; only arguments made of plain characters may go through cmd.exe; anything else is refused.
import { promises as fsp, constants as fsConstants } from 'node:fs';
import path from 'node:path';

const SHIMS = new Set(['.cmd', '.bat']);
// Characters cmd.exe gives no meaning to, so a command line made of them reads back as the same arguments.
const PLAIN_ARG = /^[A-Za-z0-9_\-.,:/\\=@+]+$/;
// The shim's own path is quoted on that command line; inside quotes only these still mean something.
const QUOTABLE_PATH = /^[^"%!^]+$/;
const SCRIPT = /\.[cm]?js$/i;
const HERE = '\u0000here\u0000';  // stands for %~dp0 / %dp0% (the shim's folder) while variables are expanded

async function exists(filePath) {
  try { await fsp.access(filePath, fsConstants.F_OK); return true; } catch { return false; }
}

/** A path from the shim's text: the shim's folder put back in place of %~dp0, its separators made this system's. */
function shimPath(value, dir) {
  if (!value.startsWith(HERE)) return path.win32.isAbsolute(value) ? value : null;
  const parts = value.slice(HERE.length).split(/[\\/]+/).filter(Boolean);
  return path.join(dir, ...parts);
}

/**
 * The script an npm shim runs, or null when the shim is not one of npm's. cmd-shim writes
 * `"%_prog%" "%dp0%\node_modules\<pkg>\cli.js" %*`; Node's own npx.cmd keeps the script in a variable
 * (`SET "NPX_CLI_JS=%~dp0\..."` then `"%NODE_EXE%" "%NPX_CLI_JS%" %*`).
 * @param {string} text @param {string} dir
 */
async function npmScript(text, dir) {
  const lines = text.split(/\r?\n/);
  const run = lines.find((line) => line.includes('%*'));
  if (!run) return null;
  const marked = (/** @type {string} */ s) => s.replace(/%~dp0|%dp0%/gi, HERE);
  /** @type {Map<string, string[]>} every value a variable is SET to, in order */
  const sets = new Map();
  for (const line of lines) {
    const m = /^\s*SET\s+"?([A-Za-z_][\w]*)=([^"]*)"?\s*$/i.exec(line);
    if (m) sets.set(m[1].toUpperCase(), [...(sets.get(m[1].toUpperCase()) ?? []), marked(m[2])]);
  }
  for (const quoted of [...run.matchAll(/"([^"]+)"/g)].map((m) => marked(m[1])).reverse()) {
    // A variable may be SET more than once (npx.cmd's second value comes from a FOR loop): the first value
    // that names a script on disk is the one the shim would run.
    const variable = /^%([A-Za-z_]\w*)%$/.exec(quoted);
    for (const value of variable ? sets.get(variable[1].toUpperCase()) ?? [] : [quoted]) {
      const file = SCRIPT.test(value) ? shimPath(value, dir) : null;
      if (file && await exists(file)) return file;
    }
  }
  return null;
}

/**
 * @param {import("../platform").SpawnSpec} spec
 * @param {{ which: (names: string[]) => Promise<string | null> }} deps
 * @returns {Promise<{ cmd: string; args: string[]; shell?: true } | { refused: string }>}
 */
export async function resolveWindowsCommand(spec, { which }) {
  let cmd = spec.cmd;
  // Node finds a bare name only as .com or .exe, so `npx` (npx.cmd) is looked up the way a shell would.
  if (cmd && !/[\\/]/.test(cmd) && !path.extname(cmd)) cmd = (await which([cmd])) ?? cmd;
  if (!SHIMS.has(path.extname(cmd).toLowerCase())) return { cmd, args: spec.args };

  const dir = path.dirname(cmd);
  const text = await fsp.readFile(cmd, 'utf8').catch(() => '');
  const script = await npmScript(text, dir);
  if (script) {
    // The shim prefers a node.exe beside it, else node from PATH; so do we.
    const node = (await exists(path.join(dir, 'node.exe'))) ? path.join(dir, 'node.exe') : await which(['node']);
    if (node) return { cmd: node, args: [script, ...spec.args] };
    return { refused: `${path.basename(cmd)} needs Node.js, which was not found on PATH. Install Node.js, or point the setting at the program itself.` };
  }
  const exe = cmd.slice(0, -path.extname(cmd).length) + '.exe';
  if (await exists(exe)) return { cmd: exe, args: spec.args };
  if (QUOTABLE_PATH.test(cmd) && spec.args.every((arg) => PLAIN_ARG.test(arg))) return { cmd: `"${cmd}"`, args: spec.args, shell: true };
  return {
    refused: `${path.basename(cmd)} is a Windows batch file, and Veritas will not pass this request through cmd.exe `
      + '(its quoting is not safe for prompts). Point the setting at the program itself: an .exe, or the script the batch file runs.',
  };
}
