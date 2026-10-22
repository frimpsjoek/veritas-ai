// @ts-check
// agent-src/src/local/discover.js (spec 010 §2). Finds MLX chat models on disk, live, through the platform's fs port.
// Two layouts: <dir>/<org>/<repo>/ (the Content drive) and the Hugging Face cache <dir>/models--<org>--<repo>/snapshots/<hash>/.
// Only models that can chat survive: weights, a chat template, and not an ASR / embedding / TTS / PII model.

/** @typedef {Pick<import("../platform").Platform["fs"], "list" | "read" | "stat">} ScanFs */
/** @typedef {import("../domain").LocalModel & { path: string, repo: string }} FoundModel */

/** Names and architectures that are not chat models (the user's list: ASR, whisper, embeddings, TTS, PII; plus close kin). */
const NOT_CHAT = /asr|whisper|speech|audio|tts|embed|rerank|pii|ctc|bert|clip|siglip|parakeet/i;

/** @param {string} dir @param {string} home */
export function expandHome(dir, home) {
  return dir === '~' ? home : dir.startsWith('~/') ? `${home}/${dir.slice(2)}` : dir;
}

const join = (a, b) => `${a.replace(/\/+$/, '')}/${b}`;

/** @param {ScanFs} fs @param {string} path */
async function readJson(fs, path) {
  try { const text = await fs.read(path); return text ? JSON.parse(text) : null; } catch { return null; }
}

/** A folder's entries, or nothing when it is a stray file (.DS_Store) or unreadable: one odd entry must not break the scan. */
async function listDir(fs, dir) {
  try { return await fs.list(dir); } catch { return []; }
}

/**
 * Pure-ish: is this folder a model a person can chat with? Returns its size, or null when not.
 * @param {ScanFs} fs @param {string} dir @param {string} repo name used for the exclusion test
 * @returns {Promise<{ sizeBytes: number | null } | null>}
 */
export async function inspectModel(fs, dir, repo) {
  const config = await readJson(fs, join(dir, 'config.json'));
  if (!config || typeof config !== 'object') return null;
  const arch = Array.isArray(config.architectures) ? config.architectures.join(' ') : '';
  if (NOT_CHAT.test(repo) || NOT_CHAT.test(arch) || NOT_CHAT.test(String(config.model_type ?? ''))) return null;
  const files = await listDir(fs, dir);
  const weights = files.filter((f) => f.endsWith('.safetensors'));
  if (!weights.length) return null;
  const tokenizer = await readJson(fs, join(dir, 'tokenizer_config.json'));
  const hasTemplate = Boolean(tokenizer?.chat_template) || files.includes('chat_template.jinja') || files.includes('chat_template.json');
  if (!hasTemplate) return null;
  let sizeBytes = null;
  if (fs.stat) {
    let total = 0;
    for (const f of weights) total += (await fs.stat(join(dir, f)))?.size ?? 0;
    sizeBytes = total || null;
  }
  return { sizeBytes };
}

/** @param {string} repo */
function woofRank(repo) { return /woof/i.test(repo) && /4b/i.test(repo) ? 0 : 1; }

/** @param {string} repo */
export function noteFor(repo) {
  if (woofRank(repo) === 0) return 'Best of the models tried here. Still gets some facts wrong.';
  if (/woof/i.test(repo) && /2b/i.test(repo)) return 'Often refuses or misses answers.';
  return 'Not tested on your library.';
}

/** @param {string} repo */
export function labelFor(repo) { return repo.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim(); }

/** @param {string} repo */
function versionOf(repo) { return Number(/(\d+\.\d+)/.exec(repo)?.[1] ?? 0); }

/** Woof 4B first, newest version first ("Underdog-Woof-4B-1.1" before "woof-1.0-4B"); the rest by name. */
function compareModels(a, b) {
  const rank = woofRank(a.repo) - woofRank(b.repo);
  if (rank) return rank;
  if (woofRank(a.repo) === 0) return versionOf(b.repo) - versionOf(a.repo) || a.repo.localeCompare(b.repo);
  return a.repo.localeCompare(b.repo, undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * @param {{ fs: ScanFs, dirs: string[], home?: string }} args
 * @returns {Promise<{ models: FoundModel[], missing: string[] }>} `missing` = scan folders that do not exist (an unmounted drive)
 */
export async function scanModels({ fs, dirs, home = '' }) {
  /** @type {Map<string, FoundModel>} */
  const found = new Map();
  /** @type {string[]} */
  const missing = [];

  /** @param {string} dir @param {string} repo */
  async function consider(dir, repo) {
    const id = `mlx:${repo}`;
    if (found.has(id)) return; // the first folder scanned wins
    const info = await inspectModel(fs, dir, repo);
    if (!info) return;
    found.set(id, { id, label: labelFor(repo.split('/').pop() ?? repo), isDefault: false, source: 'mlx', sizeBytes: info.sizeBytes, note: noteFor(repo), path: dir, repo });
  }

  for (const raw of dirs) {
    const root = expandHome(raw, home);
    if (fs.stat && !(await fs.stat(root))) { missing.push(raw); continue; }
    for (const name of await listDir(fs, root)) {
      const path = join(root, name);
      if (name.startsWith('models--')) {
        const [org, ...rest] = name.slice('models--'.length).split('--');
        const repo = rest.length ? `${org}/${rest.join('--')}` : org;
        const snaps = join(path, 'snapshots');
        for (const snap of (await listDir(fs, snaps)).sort().reverse()) {
          if (found.has(`mlx:${repo}`)) break;
          await consider(join(snaps, snap), repo);
        }
      } else if (await fs.read(join(path, 'config.json')).catch(() => null)) {
        await consider(path, name);
      } else {
        for (const child of await listDir(fs, path)) await consider(join(path, child), `${name}/${child}`);
      }
    }
  }

  const models = [...found.values()].sort(compareModels);
  if (models.length) models[0].isDefault = true;
  return { models, missing };
}
