// An in-memory stand-in for platform.d.ts's fs, shared by core.test.js and store.test.js. Real hosts implement
// this against IOUtils (Zotero) or fs/promises (Node); tests only need the JSONL append/list/remove contract.
export function memoryFs() {
  const files = new Map();
  return {
    files,
    async read(path) { return files.has(path) ? files.get(path) : null; },
    async writeAtomic(path, text) { files.set(path, text); },
    async append(path, line) { files.set(path, (files.get(path) ?? '') + line + '\n'); },
    /** Immediate children only, like fs.readdir (a nested path's first segment, not the whole remainder), so a
     *  reviews/<id>/findings/<sq>.json file shows up here as one entry named "findings", not the full path. */
    async list(dir) {
      const prefix = dir.endsWith('/') ? dir : `${dir}/`;
      const seen = new Set();
      for (const p of files.keys()) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length).split('/')[0];
        if (rest) seen.add(rest);
      }
      return [...seen];
    },
    async remove(path) { files.delete(path); },
    async symlink(target, path) { files.set(path, `symlink:${target}`); },
  };
}
