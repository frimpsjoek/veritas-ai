#!/usr/bin/env node
// packaging/sea/build.mjs. Builds the agent sidecar as one executable (Node SEA, spec 024 G3) and copies it to where
// the desktop app bundles it: app/src-tauri/binaries/agentd-<target triple>[.exe] (Tauri's externalBin naming).
//   node build.mjs              uses the node running it (Node 22) as the executable to inject into
//   TARGET_TRIPLE=...           the Rust target triple of the binary (default: `rustc -vV`'s host)
//
// How the server starts it: agent_api.py runs `<SECOND_BRAIN_NODE> <SECOND_BRAIN_AGENTD_ENTRY> --port 0 ...`. The app
// sets both to this one executable, so the server needs no change. In a SEA process.argv[1] is the executable again
// and the server's "entry" argument lands in argv[2], where agentd's --flag parsing ignores it.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const run = (cmd, args) => execFileSync(cmd, args, { cwd: here, stdio: 'inherit' });

// SEA runs one CommonJS script. agentd.mjs starts main() only when it is the script node was given
// (import.meta.url === file://argv[1]); in the bundle that question has no meaning, so the answer is made yes.
await build({
  entryPoints: [join(repo, 'agent', 'src', 'node', 'agentd.mjs')],
  outfile: join(here, 'build', 'agentd.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  define: { 'import.meta.url': '__veritasSeaMain' },
  banner: { js: 'var __veritasSeaMain = "file://" + process.argv[1];' },
});

const triple = process.env.TARGET_TRIPLE
  || execFileSync('rustc', ['-vV'], { encoding: 'utf8' }).match(/^host: (.+)$/m)?.[1];
if (!triple) throw new Error('set TARGET_TRIPLE (no rustc to ask)');
const windows = triple.includes('windows');
const mac = triple.includes('apple');
const exe = join(here, 'build', windows ? 'agentd.exe' : 'agentd');

run(process.execPath, ['--experimental-sea-config', 'sea-config.json']);
copyFileSync(process.execPath, exe);
chmodSync(exe, 0o755);
if (mac) run('codesign', ['--remove-signature', exe]); // postject cannot write into a signed binary
// its CLI script, run by node: Windows refuses to spawn the .cmd wrapper without a shell
run(process.execPath, [join(here, 'node_modules', 'postject', 'dist', 'cli.js'), exe, 'NODE_SEA_BLOB', join('build', 'sea-prep.blob'),
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2', ...(mac ? ['--macho-segment-name', 'NODE_SEA'] : [])]);
if (mac) run('codesign', ['--sign', '-', exe]); // Apple silicon runs nothing unsigned; ad hoc is enough

const dest = join(repo, 'app', 'src-tauri', 'binaries', `agentd-${triple}${windows ? '.exe' : ''}`);
mkdirSync(dirname(dest), { recursive: true });
copyFileSync(exe, dest);
console.log(`agent sidecar: ${dest} (${Math.round(statSync(dest).size / 1e6)} MB)`);
