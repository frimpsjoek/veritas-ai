// The only host-specific code. The core is plain ES2022 with zero dependencies; it touches the OS only through this port.
// Gecko impl (content/agent-host.js): Subprocess.sys.mjs, IOUtils/PathUtils, fetch, Zotero.Server.Endpoints.
// Node impl (agent-src/node/platform.mjs): child_process.spawn, fs/promises, fetch, http.createServer.

export interface ChildProcess {
  /** Newline-delimited stdout. Both CLIs speak one JSON value per line. */
  lines(): AsyncIterable<string>;
  write(line: string): Promise<void>;
  /** Cleaned stderr tail for error messages (prompt echoes and rmcp trace lines removed). */
  stderrTail(): string;
  kill(): Promise<void>;
  readonly exited: Promise<number>;
}

export interface SpawnSpec { cmd: string; args: string[]; env: Record<string, string>; cwd: string }

/** A mounted HTTP route. Zotero: one Zotero.Server endpoint at /second-brain/mcp on 23119. Node: a route on the sidecar's port. */
export interface Mount { url: string; unmount(): void }
export type HttpHandler = (req: { headers: Record<string, string>; body: string }) => Promise<{ status: number; body: string }>;

export interface Platform {
  spawn(spec: SpawnSpec): Promise<ChildProcess>;
  which(candidates: string[]): Promise<string | null>;  // binary lookup order lives in providers, not here
  fetch: typeof fetch;
  fs: {
    read(path: string): Promise<string | null>;
    writeAtomic(path: string, text: string): Promise<void>;  // temp file + rename; every stage output uses this
    append(path: string, line: string): Promise<void>;
    list(dir: string): Promise<string[]>;
    remove(path: string): Promise<void>;
    symlink(target: string, path: string): Promise<void>;
  };
  serve(path: string, handler: HttpHandler): Promise<Mount>;
  homeDir: string;
}
