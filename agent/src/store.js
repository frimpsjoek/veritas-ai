// @ts-check
// agent-src/src/store.js. Conversation history: JSONL, one file per id, owned by exactly one runtime. `append`
// is the only write, so a restart rebuilds everything by re-reading the files (no separate index to drift).
// ULIDs are minted here rather than pulled in as a dependency (agent-src has none besides esbuild/typescript).

import { summaryExtras, newsOf, coverOf, resultPath as resultPathFor } from './sessions.js';

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32, no I/O/L/U, matches the ULID spec

function encodeTime(ms) {
  let out = '';
  for (let i = 0; i < 10; i++) {
    out = ENCODING[ms % 32] + out;
    ms = Math.floor(ms / 32);
  }
  return out;
}

function randomPart() {
  let out = '';
  for (let i = 0; i < 16; i++) out += ENCODING[Math.floor(Math.random() * 32)];
  return out;
}

/** A ULID: sortable by creation time, so a conversation's own id doubles as its creation order. */
export function ulid(now = Date.now()) {
  return encodeTime(now) + randomPart();
}

/**
 * @param {import("./platform").Platform["fs"]} fs
 * @param {string} dir
 */
export function conversationStore(fs, dir) {
  const pathFor = (id) => `${dir}/${id}.jsonl`;

  function summarize(id, records) {
    const meta = records.find((r) => r.type === 'meta');
    const rename = [...records].reverse().find((r) => r.type === 'rename');
    const moved = [...records].reverse().find((r) => r.type === 'project');
    const project = moved ? moved.project ?? null : meta?.project;
    // Opening a chat (a `seen` record) is not activity: it must not move the chat up the history.
    const last = [...records].reverse().find((r) => r.type !== 'seen');
    const news = newsOf(records);
    const extras = summaryExtras(records);
    const cover = coverOf(records);
    return {
      id,
      mode: meta?.mode ?? 'chat',
      title: rename?.title ?? meta?.title ?? '(untitled)',
      updated: last?.at ?? meta?.created ?? new Date(0).toISOString(),
      artifacts: extras.artifacts,
      kind: extras.kind,
      ...(meta?.routine ? { routine: meta.routine } : {}),
      ...(project !== undefined ? { project } : {}),
      ...(news ? { news } : {}),
      ...(cover ? { cover } : {}),
    };
  }

  async function readRecords(id) {
    const text = await fs.read(pathFor(id));
    if (text === null) return null;
    return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  }

  return {
    /** @returns {Promise<import("./domain").ConversationSummary[]>} */
    async list() {
      const files = await fs.list(dir);
      const ids = files.filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -'.jsonl'.length));
      const summaries = [];
      for (const id of ids) {
        const records = await readRecords(id);
        if (records?.length) summaries.push(summarize(id, records));
      }
      return summaries.sort((a, b) => (a.updated < b.updated ? 1 : -1));
    },

    /** @returns {Promise<import("./domain").SessionRecord[]>} */
    async load(id) {
      return (await readRecords(id)) ?? [];
    },

    /** @param {import("./domain").SessionRecord} record */
    async append(id, record) {
      await fs.append(pathFor(id), JSON.stringify(record));
    },

    async remove(id) {
      await fs.remove(pathFor(id));
      // The session's result versions live beside the log (spec 007 §1.3); deleting the chat deletes them too.
      await fs.removeTree?.(`${dir}/${id}.d`);
    },

    /**
     * Takes over files from a runtime that used to own them (Zotero standalone -> sidecar). Idempotent: an id
     * already present here keeps its own history rather than being overwritten by the incoming copy. `files` is
     * the flattened `.d` folder (spec 007 §1.3: `{ path, text }[]`, `path` relative to `dir`, e.g.
     * "<id>.d/results/R1/v1.json"); it copies the same way, keep-the-first per id.
     * @param {{ id: import("./domain").ConversationId, jsonl: string, files?: { path: string, text: string }[] }[]} incoming
     * @returns {Promise<import("./domain").ConversationId[]>} ids now owned here
     */
    async adopt(incoming) {
      const adopted = [];
      for (const file of incoming) {
        const existing = await fs.read(pathFor(file.id));
        if (existing === null) {
          await fs.writeAtomic(pathFor(file.id), file.jsonl);
          for (const f of file.files ?? []) await fs.writeAtomic(`${dir}/${f.path}`, f.text);
        }
        adopted.push(file.id);
      }
      return adopted;
    },

    // ---------- spec 007: result versions (chats/<id>.d/results/<resultId>/v<n>.json) ----------

    /**
     * Writes one immutable version file. Callers append the matching `result` record only after this resolves,
     * so a crash between the two leaves an orphan file that `manifest()` simply never surfaces (§1.3).
     * @param {string} id @param {string} resultId @param {number} version @param {import("./domain").Result} body
     */
    async writeResult(id, resultId, version, body) {
      await fs.writeAtomic(`${dir}/${resultPathFor(id, resultId, version)}`, JSON.stringify(body));
    },

    /** @param {string} id @param {string} resultId @param {number} version @returns {Promise<import("./domain").Result | null>} */
    async readResult(id, resultId, version) {
      const text = await fs.read(`${dir}/${resultPathFor(id, resultId, version)}`);
      return text === null ? null : JSON.parse(text);
    },
  };
}
