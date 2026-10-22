// @ts-check
// agent-src/src/export.js. Markdown is written directly; DOCX and PDF go through pandoc via platform.spawn, the
// same Platform port every other process launch in this codebase uses (no stdin streaming: pandoc reads a real
// file, because platform.d.ts's ChildProcess has no way to close stdin, and a temp file needs none added).

const PANDOC_CANDIDATES = ['pandoc', '/opt/homebrew/bin/pandoc'];

/** @param {import("./platform").Platform} platform */
export async function findPandoc(platform) {
  return platform.which(PANDOC_CANDIDATES);
}

/**
 * @param {import("./platform").Platform} platform
 * @param {{ markdown: string, format: "md" | "docx" | "pdf", path: string, tmpDir: string }} opts
 * @returns {Promise<{ path: string }>}
 */
export async function exportReport(platform, { markdown, format, path, tmpDir }) {
  const text = markdown.endsWith('\n') ? markdown : `${markdown}\n`;
  if (format === 'md') {
    await platform.fs.writeAtomic(path, text);
    return { path };
  }

  const pandoc = await findPandoc(platform);
  if (!pandoc) {
    throw Object.assign(
      new Error(`Exporting to ${format.toUpperCase()} needs pandoc, which isn't installed. Install it (for example "brew install pandoc") and try again.`),
      { kind: 'missing_pandoc' },
    );
  }

  const srcPath = `${tmpDir}/export-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`;
  await platform.fs.writeAtomic(srcPath, text);
  try {
    const child = await platform.spawn({ cmd: pandoc, args: [srcPath, '-o', path], env: {}, cwd: tmpDir });
    const code = await child.exited;
    if (code !== 0) throw Object.assign(new Error(`pandoc exited with code ${code}: ${child.stderrTail()}`), { kind: 'export_failed' });
    return { path };
  } finally {
    await platform.fs.remove(srcPath);
  }
}
